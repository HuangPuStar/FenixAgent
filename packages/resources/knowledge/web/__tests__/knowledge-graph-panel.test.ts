import { describe, expect, test } from "bun:test";
import { ApiError } from "@/src/api/request";
import { isKnowledgeGraphNotFound } from "@/src/pages/agent-panel/components/knowledge-graph-state";

describe("KnowledgeGraphPanel error classification", () => {
  // 只有明确的 404 才表示知识库尚未生成图谱。
  test("将 NOT_FOUND 分类为空态", () => {
    expect(isKnowledgeGraphNotFound(new ApiError("missing", "NOT_FOUND"))).toBe(true);
  });

  // 权限、网络与服务端错误必须保留为错误态，不能伪装成空图谱。
  test("不将其他请求错误分类为空态", () => {
    expect(isKnowledgeGraphNotFound(new ApiError("forbidden", "UNAUTHORIZED"))).toBe(false);
    expect(isKnowledgeGraphNotFound(new ApiError("offline", "NETWORK_ERROR"))).toBe(false);
    expect(isKnowledgeGraphNotFound(new Error("invalid payload"))).toBe(false);
  });
});
