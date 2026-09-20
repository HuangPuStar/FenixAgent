import { getKnowledgeConfig } from "../config";

/**
 * 解析 RAGFlow API key —— 始终返回模块配置里的全局 key。
 *
 * 三个入参是既有调用面的占位（历史上支持按 scope / 用户解析），当前实现只读全局 key，保留签名是为了
 * 不牵动调用点（实测 23 处：web 路由 6、knowledge-runtime 5、knowledge-base 10、knowledge-upload 2）；
 * 删除它们属于接口收敛，不在本切片范围。
 */
export async function resolveRagflowApiKey(_keySource: string, _userId: string, _orgId: string): Promise<string> {
  const { ragflowApiKey } = getKnowledgeConfig();
  if (!ragflowApiKey.trim()) {
    // 未配置 RAGFlow 时的快速失败：空 Bearer token 会被上游当成鉴权失败，错误更难定位。
    throw new Error("RAGFLOW_API_KEY is not configured");
  }
  return ragflowApiKey;
}
