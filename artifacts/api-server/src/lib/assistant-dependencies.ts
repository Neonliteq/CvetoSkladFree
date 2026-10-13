/**
 * Коллабораторы, которые нужны ассистенту от слоя склада.
 *
 * Живут отдельно от маршрутов: боты не могут импортировать `routes/inventory` —
 * те импортируют сервис ассистента, а ассистенту нужны операции склада, и
 * получается цикл. Общая фабрика разрывает его и, что важнее, гарантирует, что
 * бот и веб-интерфейс работают с одним и тем же набором операций.
 *
 * Автор передаётся аргументом, а не хранится в состоянии модуля: иначе два
 * запроса могли бы приписать операцию чужому пользователю. Для ботов
 * `authorId` равен null — они подставляют автора на каждое сообщение сами.
 */
import {
  addMovement,
  editReceipt,
  recalculateDependentBouquets,
} from "./inventory-operations.ts";
import type { AssistantDependencies } from "./assistant.ts";

export function createAssistantDependencies(
  authorId: number | null,
): AssistantDependencies {
  return {
    addMovement: (
      input: Parameters<typeof addMovement>[0],
      message?: Parameters<typeof addMovement>[1],
      assistantBatchId?: string | null,
    ) => addMovement(input, message, authorId, assistantBatchId),
    editReceipt,
    recalculateDependentBouquets,
  };
}
