/**
 * Registry for the assistant collaborators the bots need.
 *
 * The bot transports cannot import the inventory routes: those routes import the
 * assistant service, and the assistant needs the movement helpers — an import
 * cycle. The server entry point owns both, so it fills this registry once at
 * startup and the bots read it when a message arrives.
 */
import type { AssistantDependencies } from "./assistant.ts";

let dependencies: AssistantDependencies | null = null;

export function provideBotDependencies(next: AssistantDependencies): void {
  dependencies = next;
}

export function botDependencies(): AssistantDependencies {
  if (!dependencies) {
    throw new Error("Bot dependencies were not registered before a message arrived");
  }
  return dependencies;
}
