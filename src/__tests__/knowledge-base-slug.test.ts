import { describe, expect, test } from "bun:test";
import { CreateKnowledgeBaseRequestSchema } from "../schemas/knowledge.schema";
import { generateKnowledgeBaseSlug } from "../services/knowledge-base";

describe("knowledge base slug generation", () => {
  // 创建知识库时应允许前端省略 slug，由后端自动生成
  test("create request schema accepts missing slug", () => {
    const result = CreateKnowledgeBaseRequestSchema.safeParse({
      name: "项目文档",
    });

    expect(result.success).toBe(true);
  });

  // 中文名称自动生成 slug 时，应回退到系统前缀并保持 kebab-case
  test("generates kebab-case fallback slug for Chinese names", () => {
    const slug = generateKnowledgeBaseSlug("项目文档");

    expect(slug).toMatch(/^kb-[0-9a-f]{8}$/);
  });

  // 英文名称自动生成 slug 时，应保留可读名称并附带随机后缀
  test("generates readable kebab-case slug for ASCII names", () => {
    const slug = generateKnowledgeBaseSlug("Project Docs");

    expect(slug).toMatch(/^project-docs-[0-9a-f]{8}$/);
  });
});
