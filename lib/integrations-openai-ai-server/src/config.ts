/**
 * Resolves the OpenAI-compatible provider configuration.
 *
 * Two naming schemes are supported so the same code runs with either set of
 * injects `AI_INTEGRATIONS_OPENAI_*`) and locally (`OPENAI_*` from `.env`).
 */
export type OpenAiProviderConfig = {
  apiKey: string;
  baseUrl: string;
};

export function resolveOpenAiProviderConfig(
  missingHint = "Did you forget to provision the OpenAI AI integration?",
): OpenAiProviderConfig {
  const apiKey =
    process.env["OPENAI_API_KEY"] ?? process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const baseUrl =
    process.env["OPENAI_BASE_URL"] ??
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];

  if (!apiKey) {
    throw new Error(
      `OPENAI_API_KEY (or AI_INTEGRATIONS_OPENAI_API_KEY) must be set. ${missingHint}`,
    );
  }
  if (!baseUrl) {
    throw new Error(
      `OPENAI_BASE_URL (or AI_INTEGRATIONS_OPENAI_BASE_URL) must be set. ${missingHint}`,
    );
  }

  return { apiKey, baseUrl };
}

/**
 * Chat model used by the AI assistant.
 *
 * The default targets DeepSeek (`deepseek-flash`); set `OPENAI_MODEL` to point
 * at any other OpenAI-compatible chat model that supports function calling.
 */
export function resolveChatModel(): string {
  return process.env["OPENAI_MODEL"] ?? "deepseek-flash";
}
