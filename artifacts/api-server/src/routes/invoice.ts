import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  assistantConversationsTable,
  assistantMessagesTable,
  db,
  productsTable,
} from "@workspace/db";
import {
  ApplyInvoiceBody,
  ApplyInvoiceResponse,
  RecognizeInvoiceBody,
  RecognizeInvoiceResponse,
} from "@workspace/api-zod";
import { requireAiProvider } from "../lib/ai-config";
import {
  formatInvoiceDraft,
  matchInvoiceLines,
  type CatalogItem,
  type MatchedLine,
} from "../lib/invoice-context";
import {
  applyMovement,
  createProductWithin,
  recalculateDependentBouquets,
} from "../lib/inventory-operations";

const router: IRouter = Router();

/** Data URL shape produced by the UI: `data:image/png;base64,AAAA...` */
const dataUrlPattern = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/u;
const maxImageBytes = 8 * 1024 * 1024;

function splitImageDataUrl(imageDataUrl: string): { mime: string; base64: string } {
  const match = dataUrlPattern.exec(imageDataUrl);
  if (!match) {
    throw new Error("Поддерживаются фото в формате JPEG, PNG, GIF или WebP");
  }
  const [, mime, base64] = match;
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > maxImageBytes) {
    throw new Error(
      `Фото слишком большое (${Math.round(bytes / 1024 / 1024)} МБ). Максимум ${maxImageBytes / 1024 / 1024} МБ`,
    );
  }
  return { mime, base64 };
}

const readInvoiceTool = {
  type: "function" as const,
  function: {
    name: "read_invoice",
    description: "Вернуть распознанные позиции накладной",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        supplierName: { type: ["string", "null"] },
        invoiceNumber: { type: ["string", "null"] },
        invoiceDate: {
          type: ["string", "null"],
          description: "Дата документа в формате YYYY-MM-DD",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["rawName", "quantity", "unitPrice"],
            properties: {
              rawName: {
                type: "string",
                description: "Название позиции ровно как напечатано в документе",
              },
              quantity: { type: "number" },
              unit: { type: ["string", "null"] },
              unitPrice: { type: "number" },
            },
          },
        },
        unclearFields: {
          type: "array",
          items: { type: "string" },
          description: "Поля, которые не удалось прочитать",
        },
      },
    },
  },
};

function invoiceSystemPrompt(catalog: CatalogItem[], today: string, comment?: string) {
  return `Ты распознаёшь бумажные накладные цветочного магазина по фотографии.
Верни ровно один вызов инструмента read_invoice.
Читай данные строго из документа: название позиции, количество, единицу измерения и цену за единицу.
Название переноси ровно как напечатано — вместе с сортом, длиной стебля и размером упаковки. Не сокращай, не переводи и не подставляй названия из каталога.
Не добавляй позиции, которых нет в документе, и не пропускай строки таблицы. Итоговую строку «Итого» позицией не считай.
Если количество или цена не читаются, верни 0 и перечисли поле в unclearFields.
Сегодняшняя дата: ${today}.
Каталог магазина для справки (сопоставление делает сервер, использовать эти названия в rawName нельзя): ${JSON.stringify(
    catalog.map((item) => ({ name: item.name, unit: item.unit })),
  )}${comment ? `\nДополнительные указания пользователя: ${comment}` : ""}`;
}

router.post("/assistant/invoice/recognize", async (req, res): Promise<void> => {
  const parsed = RecognizeInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужны фото накладной и идентификатор диалога" });
    return;
  }

  let image: { mime: string; base64: string };
  try {
    image = splitImageDataUrl(parsed.data.imageDataUrl);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось прочитать изображение",
    });
    return;
  }

  const products = await db.select().from(productsTable);
  const catalog: CatalogItem[] = products.map((product) => ({
    id: product.id,
    name: product.name,
    aliases: product.aliases,
    category: product.category,
    unit: product.unit,
    averagePrice: product.averagePrice,
    currentStock: product.currentStock,
    markupPercent: product.markupPercent,
    shelfLifeDays: product.shelfLifeDays,
    productType: product.productType,
  }));

  try {
    const today = new Date().toISOString().slice(0, 10);
    // Провайдер — из настроек администратора (с откатом на окружение).
    const provider = await requireAiProvider();
    // The photo comes from a phone over a mobile connection and the default 20 s
    // request timeout is easy to exceed on 4G: uploading ~11 MB of base64 happens
    // inside this call. The wait is invisible because the UI shows a progress state.
    const completion = await provider.client.chat.completions.create(
      {
        model: provider.model,
        max_tokens: 4000,
        messages: [
          {
            role: "system",
            content: invoiceSystemPrompt(catalog, today, parsed.data.comment || undefined),
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Разбери эту накладную и верни все позиции." },
              { type: "image_url", image_url: { url: parsed.data.imageDataUrl } },
            ],
          },
        ],
        tools: [readInvoiceTool],
        // DeepSeek enables thinking mode by default; in that mode tool-calling
        // turns must echo `reasoning_content` back, which this API does not store.
        ...({ extra_body: { thinking: { type: "disabled" } } } as object),
      },
      { timeout: 90_000, maxRetries: 1 },
    );

    const message = completion.choices[0]?.message;
    // Тип объединённый (function | custom), поэтому сужаем явно: нужен только
    // вызов инструмента, остальное игнорируем.
    const toolCall = message?.tool_calls?.find(
      (call): call is Extract<typeof call, { type: "function" }> =>
        call.type === "function",
    );
    if (!toolCall) {
      await recordConversation(parsed.data.conversationId, {
        user: `Фото накладной (${image.mime.replace("image/", "")})`,
        assistant:
          message?.content?.trim() ||
          "Не удалось распознать позиции на фото. Сфотографируйте документ целиком и ровнее.",
      });
      res.status(400).json({
        error:
          message?.content?.trim() ||
          "Не удалось распознать позиции накладной. Сфотографируйте документ целиком.",
      });
      return;
    }

    let payload: {
      supplierName?: string | null;
      invoiceNumber?: string | null;
      invoiceDate?: string | null;
      items?: Array<{
        rawName?: string;
        quantity?: number;
        unit?: string | null;
        unitPrice?: number;
      }>;
      unclearFields?: string[];
    };
    try {
      payload = JSON.parse(toolCall.function.arguments);
    } catch {
      res.status(400).json({ error: "Ассистент вернул нечитаемые данные накладной" });
      return;
    }

    const recognisedLines = (payload.items ?? []).filter(
      (item): item is { rawName: string; quantity?: number; unit?: string | null; unitPrice?: number } =>
        typeof item.rawName === "string" && item.rawName.trim().length > 0,
    );
    if (!recognisedLines.length) {
      await recordConversation(parsed.data.conversationId, {
        user: `Фото накладной (${image.mime.replace("image/", "")})`,
        assistant:
          "В документе не найдено ни одной позиции. Убедитесь, что видна таблица с товарами.",
      });
      res.status(400).json({
        error: "В накладной не найдено ни одной позиции. Проверьте, что видна таблица с товарами.",
      });
      return;
    }

    const items = matchInvoiceLines({
      lines: recognisedLines.map((line) => ({
        rawName: line.rawName,
        quantity: typeof line.quantity === "number" ? line.quantity : 0,
        unitPrice: typeof line.unitPrice === "number" ? line.unitPrice : 0,
        unit: line.unit ?? null,
      })),
      catalog: catalog.filter((item) => item.productType === "stock"),
    });

    const warnings = [...(payload.unclearFields ?? [])];
    const supplierName = payload.supplierName ?? null;
    const invoiceNumber = payload.invoiceNumber ?? null;
    const invoiceDate = payload.invoiceDate ?? null;
    const answer = formatInvoiceDraft({
      supplierName,
      invoiceNumber,
      invoiceDate,
      items,
    });

    const draft = {
      supplierName,
      invoiceNumber,
      invoiceDate,
      items,
      recognized: items.length,
      catalogLines: items.filter((item) => item.productId !== null).length,
      warnings,
    };

    await recordConversation(
      parsed.data.conversationId,
      {
        user: `Фото накладной${supplierName ? ` от «${supplierName}»` : ""} (${image.mime.replace("image/", "")})`,
        assistant: answer,
        invoiceDraft: draft,
        // A downscaled copy travels with the request so the conversation can show
        // which document was processed without storing the full-size photo.
        imageThumbnail: normalizeThumbnail(parsed.data.thumbnailDataUrl) ?? undefined,
      },
      { assistantAction: "invoice_recognized" },
    );

    res.json(RecognizeInvoiceResponse.parse(draft));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось распознать накладную",
    });
  }
});

router.post("/assistant/invoice/apply", async (req, res): Promise<void> => {
  const parsed = ApplyInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте позиции накладной: количество и цену" });
    return;
  }
  const { conversationId, items, supplierName, invoiceNumber, invoiceDate } = parsed.data;

  const catalogueIds = items
    .map((item) => item.productId)
    .filter((id): id is number => typeof id === "number");
  if (new Set(catalogueIds).size !== catalogueIds.length) {
    res.status(400).json({
      error: "Один товар указан в накладной несколько раз — объедините строки",
    });
    return;
  }

  try {
    const products = catalogueIds.length
      ? await db.select().from(productsTable).where(inArray(productsTable.id, catalogueIds))
      : [];
    const productById = new Map(products.map((product) => [product.id, product]));
    for (const item of items) {
      if (item.productId == null) {
        if (!item.newProduct) {
          throw new Error(
            `«${item.rawName}» не сопоставлен с каталогом: выберите товар или создайте новый`,
          );
        }
        continue;
      }
      const product = productById.get(item.productId);
      if (!product) throw new Error(`Товар «${item.rawName}» не найден в каталоге`);
      if (product.productType !== "stock") {
        throw new Error(`«${product.name}» — готовый букет, приход оформляется по компонентам`);
      }
    }

    const result = await db.transaction(async (tx) => {
      const created: Array<{ id: number; quantity: number; totalCost: number }> = [];
      const createdProductIds: number[] = [];
      const affectedProductIds: number[] = [];

      // Lines for existing products are resolved and locked first, in a stable
      // order, so concurrent imports cannot deadlock on each other.
      for (const productId of [...catalogueIds].sort((left, right) => left - right)) {
        await tx
          .select({ id: productsTable.id })
          .from(productsTable)
          .where(eq(productsTable.id, productId))
          .for("update");
      }

      for (const line of items) {
        let productId = line.productId ?? null;
        if (productId == null && line.newProduct) {
          // A product the user created from the invoice line is inserted here so
          // the receipt and the catalog entry land together or not at all.
          const created2 = await createProductWithin(tx, {
            name: line.newProduct.name.trim(),
            aliases: line.newProduct.aliases,
            category: line.newProduct.category,
            variety: line.newProduct.variety,
            color: line.newProduct.color,
            originCountry: line.newProduct.originCountry,
            supplier: line.newProduct.supplier ?? supplierName ?? undefined,
            unit: line.newProduct.unit,
            minimumStock: line.newProduct.minimumStock ?? 0,
            purchasePrice: line.unitPrice,
            markupPercent: line.newProduct.markupPercent ?? 0,
            shelfLifeDays: line.newProduct.shelfLifeDays ?? 0,
          });
          productId = created2.id;
          createdProductIds.push(created2.id);
        }

        const movement = await applyMovement(
          tx,
          {
            productId: productId!,
            type: "receipt",
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            reason: supplierName
              ? `Приход по накладной: ${supplierName}`
              : "Приход по накладной",
            orderNumber: invoiceNumber ?? undefined,
            batchArrivalDate: invoiceDate ?? undefined,
          },
          undefined,
          { skipBouquetRecalculation: true },
        );
        affectedProductIds.push(productId!);
        created.push({
          id: movement.id,
          quantity: line.quantity,
          totalCost: line.quantity * line.unitPrice,
        });
      }

      // Bouquet costs depend on several components at once, so they are
      // recalculated once per affected product after every line is written.
      for (const productId of new Set(affectedProductIds)) {
        await recalculateDependentBouquets(tx, productId);
      }
      return { created, createdProductIds };
    });

    const quantity = result.created.reduce((sum, line) => sum + line.quantity, 0);
    const totalCost =
      Math.round(result.created.reduce((sum, line) => sum + line.totalCost, 0) * 100) / 100;
    const createdNote = result.createdProductIds.length
      ? ` Создано товаров: ${result.createdProductIds.length}.`
      : "";
    const answer = `Приход по накладной проведён: ${result.created.length} поз., ${quantity} ед. на ${totalCost} ₽.${
      invoiceNumber ? ` Документ № ${invoiceNumber}.` : ""
    }${createdNote}`;

    // The draft card is marked as applied so the UI stops offering confirmation.
    // The stored metadata is merged instead of replaced: it still holds the
    // recognised document that the card renders from.
    const [recognizedMessage] = await db
      .select({
        id: assistantMessagesTable.id,
        invoiceMetadata: assistantMessagesTable.invoiceMetadata,
      })
      .from(assistantMessagesTable)
      .where(
        and(
          eq(assistantMessagesTable.conversationId, conversationId),
          eq(assistantMessagesTable.action, "invoice_recognized"),
        ),
      )
      .orderBy(desc(assistantMessagesTable.id))
      .limit(1);
    if (recognizedMessage) {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(recognizedMessage.invoiceMetadata ?? "{}");
      } catch {
        metadata = {};
      }
      await db
        .update(assistantMessagesTable)
        .set({
          action: "invoice_applied",
          invoiceMetadata: JSON.stringify({ ...metadata, appliedCount: result.created.length }),
        })
        .where(eq(assistantMessagesTable.id, recognizedMessage.id));
    }

    // Each receipt line is its own movement; the conversation marks the last one
    // as the operation the user can revert.
    await recordConversation(
      conversationId,
      {
        user: "Подтверждаю приход по накладной",
        assistant: answer,
        movementId: result.created[result.created.length - 1]?.id ?? null,
        invoiceMetadata: { appliedCount: result.created.length },
      },
      { assistantAction: "invoice_receipt_created" },
    );

    res.json(
      ApplyInvoiceResponse.parse({
        answer,
        action: "invoice_receipt_created",
        operationIds: result.created.map((line) => line.id),
        canUndo: result.created.length === 1,
        quantity,
        totalCost,
        createdProductIds: result.createdProductIds,
      }),
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось провести приход",
    });
  }
});

/** Keeps only well-formed image data URLs, so nothing else can be persisted. */
function normalizeThumbnail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return dataUrlPattern.test(value) && value.length <= 400_000 ? value : null;
}

/** Stores the exchange in the assistant conversation so the UI keeps context. */
async function recordConversation(
  conversationId: string,
  messages: {
    user: string;
    assistant: string;
    movementId?: number | null;
    invoiceDraft?: unknown;
    invoiceMetadata?: { appliedCount?: number };
    imageThumbnail?: string;
  },
  options?: { assistantAction?: string },
) {
  await db
    .insert(assistantConversationsTable)
    .values({ id: conversationId })
    .onConflictDoUpdate({
      target: assistantConversationsTable.id,
      set: { updatedAt: new Date() },
    });
  await db.insert(assistantMessagesTable).values({
    conversationId,
    role: "user",
    content: messages.user,
  });
  await db.insert(assistantMessagesTable).values({
    conversationId,
    role: "assistant",
    content: messages.assistant,
    action: options?.assistantAction ?? "invoice_reply",
    movementId: messages.movementId ?? null,
    // The draft lives next to the message the user acts on, so the review card
    // survives a reload without adding a table.
    invoiceMetadata: JSON.stringify({
      ...(messages.invoiceDraft ? { draft: messages.invoiceDraft } : {}),
      ...(messages.imageThumbnail ? { imageThumbnail: messages.imageThumbnail } : {}),
      ...(messages.invoiceMetadata ?? {}),
    }),
  });
}

export default router;
