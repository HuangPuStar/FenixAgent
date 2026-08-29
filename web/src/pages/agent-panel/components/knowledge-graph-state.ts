import { ApiError } from "@/src/api/request";

/** 仅将统一请求层明确标记的 404 视为“尚未生成图谱”。 */
export function isKnowledgeGraphNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "NOT_FOUND";
}
