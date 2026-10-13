export const ASSISTANT_CONVERSATION_STORAGE_KEY =
  "flower-stock-assistant-conversation";

export type StoredAssistantMessage = {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  action?: string | null;
  operationId?: number | null;
  canUndo?: boolean;
  invoiceDraft?: unknown;
  invoiceReview?: { status: "pending" | "applied"; appliedCount?: number | null };
  imageThumbnail?: string | null;
};

export function getOrCreateConversationId(
  storage: Pick<Storage, "getItem" | "setItem">,
  createId: () => string,
) {
  const existing = storage.getItem(ASSISTANT_CONVERSATION_STORAGE_KEY);
  const id = existing || createId();
  storage.setItem(ASSISTANT_CONVERSATION_STORAGE_KEY, id);
  return id;
}

export function replaceConversationId(
  storage: Pick<Storage, "setItem">,
  createId: () => string,
) {
  const id = createId();
  storage.setItem(ASSISTANT_CONVERSATION_STORAGE_KEY, id);
  return id;
}

export function restoreAssistantMessages(messages: StoredAssistantMessage[]) {
  return messages.map((message) => {
    const restored: Record<string, unknown> = {
      id: String(message.id),
      role: message.role,
      content: message.content,
      action: message.action ?? undefined,
    };
    if (message.operationId != null || message.canUndo !== undefined) {
      restored.operationId = message.operationId ?? undefined;
      restored.canUndo = message.canUndo ?? false;
    }
    if (message.invoiceDraft) restored.invoiceDraft = message.invoiceDraft;
    if (message.invoiceReview) restored.invoiceReview = message.invoiceReview;
    if (message.imageThumbnail) restored.imagePreview = message.imageThumbnail;
    return restored;
  });
}
export function retainLatestUndoAction<T extends { canUndo?: boolean }>(
  messages: T[],
  nextOperationId: number | null | undefined,
) {
  return nextOperationId == null
    ? messages
    : messages.map((message) => ({ ...message, canUndo: false }));
}