import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_CONVERSATION_STORAGE_KEY,
  getOrCreateConversationId,
  retainLatestUndoAction,
  replaceConversationId,
  restoreAssistantMessages,
} from "./assistant-state.ts";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set(ASSISTANT_CONVERSATION_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: () => values.get(ASSISTANT_CONVERSATION_STORAGE_KEY),
  };
}

test("restores the same conversation and its history after reopening", () => {
  const storage = memoryStorage("conversation-1");
  assert.equal(
    getOrCreateConversationId(storage, () => "conversation-2"),
    "conversation-1",
  );
  assert.deepEqual(
    restoreAssistantMessages([
      { id: 1, role: "user", content: "Добавь приход" },
      { id: 2, role: "assistant", content: "Какой товар?", action: "answered" },
    ]),
    [
      { id: "1", role: "user", content: "Добавь приход", action: undefined },
      {
        id: "2",
        role: "assistant",
        content: "Какой товар?",
        action: "answered",
      },
    ],
  );
});

test("clearing the dialog replaces the persisted conversation id", () => {
  const storage = memoryStorage("conversation-1");
  assert.equal(
    replaceConversationId(storage, () => "conversation-2"),
    "conversation-2",
  );
  assert.equal(storage.value(), "conversation-2");
});

test("a read-only assistant answer keeps the latest operation undoable", () => {
  const messages = [
    {
      id: "operation",
      role: "assistant" as const,
      content: "Приход добавлен",
      operationId: 42,
      canUndo: true,
    },
  ];

  assert.equal(retainLatestUndoAction(messages, null)[0]?.canUndo, true);
  assert.equal(retainLatestUndoAction(messages, undefined)[0]?.canUndo, true);
});

test("a newer movement disables undo for the previous operation", () => {
  const messages = [
    {
      id: "operation",
      role: "assistant" as const,
      content: "Приход добавлен",
      operationId: 42,
      canUndo: true,
    },
  ];

  assert.equal(retainLatestUndoAction(messages, 43)[0]?.canUndo, false);
});