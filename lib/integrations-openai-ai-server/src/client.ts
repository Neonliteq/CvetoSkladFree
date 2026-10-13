import OpenAI from "openai";
import { resolveOpenAiProviderConfig } from "./config";

const { apiKey, baseUrl } = resolveOpenAiProviderConfig();

export const openai = new OpenAI({ apiKey, baseURL: baseUrl });
