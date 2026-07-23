import OpenAI from "openai";
import {OPENAI_API_KEY, OPENAI_BASE_URL} from "../config";

/**
 * Lazily constructs the OpenAI-compatible client from runtime secrets.
 * @return {OpenAI} A configured client pointed at OPENAI_BASE_URL.
 */
export function openaiClient(): OpenAI {
  return new OpenAI({
    apiKey: OPENAI_API_KEY.value(),
    baseURL: OPENAI_BASE_URL.value(),
  });
}
