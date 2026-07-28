import { config } from "../config";

/** 解析 RAGFlow API key —— 始终返回全局配置的 key */
export async function resolveRagflowApiKey(_keySource: string, _userId: string, _orgId: string): Promise<string> {
  if (!config.ragflowApiKey.trim()) {
    throw new Error("RAGFLOW_API_KEY is not configured");
  }
  return config.ragflowApiKey;
}
