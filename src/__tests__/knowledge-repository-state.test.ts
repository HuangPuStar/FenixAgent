import { afterEach, describe, expect, test } from "bun:test";
import { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import { resetKnowledgeRepositoryMethodOverrides } from "../test-utils/knowledge-repository-state";

const TEST_MARKER = Symbol("knowledge-repository-test-marker");

afterEach(() => {
  resetKnowledgeRepositoryMethodOverrides();
  Reflect.deleteProperty(knowledgeBaseRepo, TEST_MARKER);
});

describe("knowledge repository 测试状态恢复", () => {
  // 测试直接覆盖 repository 方法后，恢复入口必须删除 own property 并重新暴露原型实现。
  test("清除三个 repository 的方法覆盖", () => {
    knowledgeBaseRepo.create = async () => ({ id: "mock-base" }) as never;
    knowledgeResourceRepo.create = async () => ({ id: "mock-resource" }) as never;
    agentKnowledgeBindingRepo.create = async () => ({ id: "mock-binding" }) as never;

    resetKnowledgeRepositoryMethodOverrides();

    expect(Object.hasOwn(knowledgeBaseRepo, "create")).toBeFalse();
    expect(Object.hasOwn(knowledgeResourceRepo, "create")).toBeFalse();
    expect(Object.hasOwn(agentKnowledgeBindingRepo, "create")).toBeFalse();
  });

  // 恢复方法覆盖时不得删除 repository 上与原型方法无关的实例数据。
  test("保留非方法实例属性", () => {
    Reflect.set(knowledgeBaseRepo, TEST_MARKER, "keep");

    resetKnowledgeRepositoryMethodOverrides();

    expect(Reflect.get(knowledgeBaseRepo, TEST_MARKER)).toBe("keep");
  });
});
