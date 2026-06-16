import { describe, expect, test } from "bun:test";
import { isRemoteKnowledgeBaseMissingError } from "../services/knowledge-base";

describe("knowledge base deletion helpers", () => {
  test("识别远端知识库已不存在的删除错误", () => {
    expect(isRemoteKnowledgeBaseMissingError(new Error("code=102: Dataset not found"))).toBe(true);
    expect(isRemoteKnowledgeBaseMissingError(new Error("HTTP 404"))).toBe(true);
  });

  test("不会把权限或网络错误误判为远端已不存在", () => {
    expect(isRemoteKnowledgeBaseMissingError(new Error("HTTP 401"))).toBe(false);
    expect(isRemoteKnowledgeBaseMissingError(new Error("fetch failed"))).toBe(false);
  });
});
