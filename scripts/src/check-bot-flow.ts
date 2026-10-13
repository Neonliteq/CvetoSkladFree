/**
 * Проверяет, что бот доводит команду до конца.
 *
 * Мессенджер не показывает карточку с кнопкой «Провести», поэтому разбор
 * сохраняется на сервере и ждёт следующего сообщения: «да» проводит его, а
 * номер или название закрывает спорную позицию. Скрипт гоняет сообщения через
 * тот же путь, что и живой бот (`answerIncomingMessage`), и проверяет, что склад
 * действительно изменился.
 *
 * Usage (из корня репозитория, с DATABASE_URL):
 *   pnpm --filter @workspace/scripts exec tsx src/check-bot-flow.ts
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { channelIdentitiesTable, db, productsTable, usersTable } from "@workspace/db";
import { answerIncomingMessage } from "@workspace/api-server/lib/bot-handler";
import { createAssistantDependencies } from "@workspace/api-server/lib/assistant-dependencies";

/** Сброс демо-данных: проверки читают и меняют склад, стартовать нужно с одного состояния. */
function seedDatabase() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://flower_stock:flower_stock@127.0.0.1:5432/flower_stock";
  const output = execFileSync(
    "pnpm",
    ["--filter", "@workspace/scripts", "run", "seed"],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      encoding: "utf8",
    },
  );
  console.log(`seed: ${output.trim().split("\n").slice(-6).join(" ").replace(/\s+/g, " ").slice(0, 110)}`);
}

seedDatabase();

const results: Array<[string, boolean, string?]> = [];
const record = (label: string, ok: boolean, detail?: string) => {
  results.push([label, ok, detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const [admin] = await db
  .select()
  .from(usersTable)
  .where(eq(usersTable.username, "admin"));
if (!admin) throw new Error("В базе нет пользователя admin — сначала прогоните seed");

const externalId = `bot-flow-${Date.now()}`;
await db.insert(channelIdentitiesTable).values({
  channel: "telegram",
  externalId,
  userId: admin.id,
  displayName: "Проверка бота",
});

/** Отправляет сообщение боту и возвращает ответ. */
async function say(text: string, identity = externalId) {
  const dependencies = createAssistantDependencies(admin!.id);
  let reply = "";
  await answerIncomingMessage(
    { channel: "telegram", externalId: identity, text, displayName: null, username: null },
    dependencies,
    async (answer) => {
      reply = answer;
    },
  );
  console.log(`  → «${text}»`);
  console.log(`    ${reply.replace(/\n/g, "\n    ")}`);
  return reply;
}

const stockOf = async (name: string) =>
  (
    await db.select().from(productsTable).where(eq(productsTable.name, name))
  )[0]?.currentStock;

try {
  console.log("=== 1. Вопрос о складе отвечается данными ===");
  const stockAnswer = await say("сколько роз на складе");
  record(
    "в ответе есть названия и остатки",
    /Роза/.test(stockAnswer) && /\d/.test(stockAnswer) && !/Какой выбрать/.test(stockAnswer),
    stockAnswer.slice(0, 160),
  );
  record(
    "ответ пересказан, а не выгружен строками данных",
    !/закупка \d/.test(stockAnswer),
    stockAnswer.slice(0, 200),
  );

  console.log("\n=== 2. Одна позиция проводится сразу ===");
  const beforeWriteoff = await stockOf("Хризантема белая");
  const single = await say("списали 2 хризантемы");
  const afterWriteoff = await stockOf("Хризантема белая");
  record(
    "одиночная команда проведена",
    /Списано/.test(single) && afterWriteoff === (beforeWriteoff ?? 0) - 2,
    `${beforeWriteoff} → ${afterWriteoff}: ${single.slice(0, 100)}`,
  );

  console.log("\n=== 3. Составная команда ждёт подтверждения ===");
  const beforeSale = await stockOf("Роза Эквадор красная");
  const beforeKenya = await stockOf("Роза Кения белая");
  const preview = await say("продали 3 розы и списали 2 хризантемы");
  record(
    "бот показал разбор, а не провёл молча",
    /Проверьте операции|Нужно уточнить/.test(preview),
    preview.slice(0, 140),
  );
  record(
    "спорная позиция предлагается номерами",
    /\d\.\s*Роза/.test(preview),
    preview.slice(0, 200),
  );
  record(
    "склад пока не изменился",
    (await stockOf("Роза Эквадор красная")) === beforeSale,
    `остаток ${await stockOf("Роза Эквадор красная")}`,
  );

  console.log("\n=== 4. Ответ номером закрывает спорную позицию ===");
  // Порядок вариантов определяет модель, поэтому проверяем не «какой именно
  // товар», а что списан ровно один вариант и ровно на нужное количество.
  const picked = await say("1");
  record(
    "бот провёл операцию после выбора товара",
    /Продажа проведена|Проведено операций/.test(picked),
    picked.slice(0, 160),
  );
  const deltaKenya = (beforeKenya ?? 0) - (await stockOf("Роза Кения белая"));
  const deltaEcuador = (beforeSale ?? 0) - (await stockOf("Роза Эквадор красная"));
  record(
    "списан ровно один вариант из списка",
    (deltaKenya === 3 && deltaEcuador === 0) || (deltaKenya === 0 && deltaEcuador === 3),
    `Кения -${deltaKenya}, Эквадор -${deltaEcuador}`,
  );
  record(
    "в ответе назван товар, с которого списали",
    /Кения|Эквадор/.test(picked),
    picked.slice(0, 140),
  );

  console.log("\n=== 5. Ответ названием товара тоже работает ===");
  const beforeSecond = await stockOf("Роза Кения белая");
  const beforeNamed = await stockOf("Роза Эквадор красная");
  const preview2 = await say("продали 2 розы");
  // Формулировка зависит от того, кто задал вопрос — модель или наш разбор,
  // поэтому проверяем сам факт вопроса, а не фразу.
  record(
    "спорная позиция спрошена",
    /уточните, какой товар|подходит несколько товаров|Какой выбрать/.test(preview2),
    preview2.slice(0, 140),
  );
  const picked2 = await say("Роза Эквадор красная");
  record(
    "операция проведена после ответа названием",
    /Продажа проведена/.test(picked2),
    picked2.slice(0, 140),
  );
  record(
    "списан именно названный товар",
    (await stockOf("Роза Эквадор красная")) === (beforeNamed ?? 0) - 2,
    `Эквадор ${beforeNamed} → ${await stockOf("Роза Эквадор красная")}`,
  );
  record(
    "остаток второго варианта не тронут",
    (await stockOf("Роза Кения белая")) === beforeSecond,
    `Кения ${beforeSecond} → ${await stockOf("Роза Кения белая")}`,
  );

  console.log("\n=== 6. Подтверждение словом «да» ===");
  const preview3 = await say("продали 1 эвкалипт и 2 ленты");
  record(
    "разбор показан без спорных позиций",
    /Проверьте операции/.test(preview3),
    preview3.slice(0, 140),
  );
  const confirmed = await say("да");
  record(
    "«да» проводит разбор",
    /Продано|Продажа/.test(confirmed),
    confirmed.slice(0, 160),
  );

  console.log("\n=== 7. Отмена разбора ===");
  const beforeCancel = await stockOf("Роза Эквадор красная");
  const preview4 = await say("продали 1 розу и 1 хризантему");
  // «нет» отменяет только сохранённый разбор, поэтому сначала убеждаемся, что
  // разбор вообще предложен: иначе проверка зависела бы от того, угадала ли
  // модель спорную позицию, и падала бы через раз.
  record(
    "разбор предложен и ждёт ответа",
    /Проверьте операци|уточните|Какой выбрать|Подтвердите/.test(preview4),
    preview4.slice(0, 140),
  );
  const cancelled = await say("нет");
  record(
    "отмена объясняет, что склад не изменён",
    /не изменён/.test(cancelled),
    cancelled.slice(0, 140),
  );
  record(
    "после отмены склад не изменился",
    (await stockOf("Роза Эквадор красная")) === beforeCancel,
    `остаток ${await stockOf("Роза Эквадор красная")}`,
  );
  const afterCancel = await say("да");
  record(
    "после отмены «да» не проводит старый разбор",
    !/Продано/.test(afterCancel),
    afterCancel.slice(0, 140),
  );

  console.log("\n=== 8. Ответ, не похожий на выбор, не проводится ===");
  const unclear = await say("продали 5 роз");
  record(
    "бот спросил товар",
    /уточните, какой товар|подходит несколько товаров|Какой выбрать/.test(unclear),
    unclear.slice(0, 120),
  );
  const empty = await say("ну не знаю");
  record(
    "непонятный ответ не проводит операцию",
    !/Продано/.test(empty),
    empty.slice(0, 140),
  );

  console.log("\n=== 9. Архивный товар ассистенту не виден ===");
  // Товар с историей, чтобы он именно ушёл в архив, а не удалился.
  const [archivedProduct] = await db
    .insert(productsTable)
    .values({
      name: "Архивный зонд бота",
      category: "Проверка",
      unit: "шт",
      purchasePrice: 10,
      averagePrice: 10,
      salePrice: 20,
      markupPercent: 100,
      minimumStock: 0,
      shelfLifeDays: 0,
      productType: "stock",
    })
    .returning();
  await db
    .update(productsTable)
    .set({ archivedAt: new Date() })
    .where(eq(productsTable.id, archivedProduct.id));

  // Отдельный собеседник: в текущем диалоге висит незакрытое уточнение из шага 8,
  // и ответ на новую команду подменялся бы повтором старого вопроса.
  const archiveIdentity = `bot-archive-${Date.now()}`;
  await db.insert(channelIdentitiesTable).values({
    channel: "telegram",
    externalId: archiveIdentity,
    userId: admin.id,
    displayName: "Проверка архива",
  });
  const archivedAnswer = await say("продали 1 архивный зонд бота", archiveIdentity);
  record(
    "архивный товар не проводится операцией",
    !/Продано/.test(archivedAnswer) &&
      /не удалось распознать|не найден|Не нашёл/i.test(archivedAnswer),
    archivedAnswer.slice(0, 160),
  );
  await db
    .delete(channelIdentitiesTable)
    .where(eq(channelIdentitiesTable.externalId, archiveIdentity));
  const [stillArchived] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, archivedProduct.id));
  record(
    "остаток архивного товара не изменился",
    (stillArchived?.currentStock ?? 0) === 0,
    `остаток ${stillArchived?.currentStock}`,
  );
  await db.delete(productsTable).where(eq(productsTable.id, archivedProduct.id));
} finally {
  await db
    .delete(channelIdentitiesTable)
    .where(eq(channelIdentitiesTable.externalId, externalId));
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
