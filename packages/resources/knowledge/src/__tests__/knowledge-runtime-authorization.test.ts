import { describe, expect, test } from "bun:test";
import { moduleManifest } from "../../fenix.module";
import {
  assertKnowledgeRuntimeBindingsInScope,
  KnowledgeRuntimeAccessError,
  resolveKnowledgeRuntimeAccessScope,
} from "../server/services/knowledge-runtime-authorization";
import { createKnowledgeModuleConfig } from "../server/testing";

function captureAccessError(action: () => void): KnowledgeRuntimeAccessError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeRuntimeAccessError);
    return error as KnowledgeRuntimeAccessError;
  }
  throw new Error("expected KnowledgeRuntimeAccessError");
}

describe("知识运行时授权范围", () => {
  test("启动期声明默认 owner 并拒绝非法模式", () => {
    const definition = moduleManifest.envDefinitions?.find((item) => item.key === "KNOWLEDGE_RUNTIME_AUTH_MODE");

    expect(definition?.schema.parse(undefined)).toBe("owner");
    expect(definition?.schema.safeParse("trusted-delegate").success).toBe(true);
    expect(definition?.schema.safeParse("unrestricted").success).toBe(false);
  });

  test("测试默认配置和 owner 模式均保持现有绑定授权语义", () => {
    expect(createKnowledgeModuleConfig().runtimeAuthMode).toBe("owner");
    expect(resolveKnowledgeRuntimeAccessScope("owner", {})).toEqual({
      mode: "owner",
      trustedDelegate: false,
      userId: null,
      organizationId: null,
    });
  });

  test("trusted-delegate 缺少用户身份时失败关闭", () => {
    const error = captureAccessError(() =>
      resolveKnowledgeRuntimeAccessScope("trusted-delegate", { organizationId: "org-1" }),
    );

    expect(error.code).toBe("KNOWLEDGE_RUNTIME_IDENTITY_REQUIRED");
  });

  test("trusted-delegate 缺少组织身份时失败关闭", () => {
    const error = captureAccessError(() =>
      resolveKnowledgeRuntimeAccessScope("trusted-delegate", { userId: "user-1" }),
    );

    expect(error.code).toBe("KNOWLEDGE_RUNTIME_ORGANIZATION_REQUIRED");
  });

  test("trusted-delegate 规范化身份并要求所有绑定知识库同组织", () => {
    const access = resolveKnowledgeRuntimeAccessScope("trusted-delegate", {
      userId: " user-1 ",
      organizationId: " org-1 ",
    });

    expect(access).toEqual({
      mode: "trusted-delegate",
      trustedDelegate: true,
      userId: "user-1",
      organizationId: "org-1",
    });
    expect(() =>
      assertKnowledgeRuntimeBindingsInScope(access, [
        { id: "kb-1", organizationId: "org-1" },
        { id: "kb-2", organizationId: " org-1 " },
      ]),
    ).not.toThrow();
  });

  test.each([
    ["跨组织", "org-2"],
    ["组织缺失", null],
    ["组织为空串", ""],
  ])("trusted-delegate 遇到%s的绑定即拒绝整次请求", (_caseName, organizationId) => {
    const access = resolveKnowledgeRuntimeAccessScope("trusted-delegate", {
      userId: "user-1",
      organizationId: "org-1",
    });

    const error = captureAccessError(() =>
      assertKnowledgeRuntimeBindingsInScope(access, [
        { id: "kb-ok", organizationId: "org-1" },
        { id: "kb-invalid", organizationId },
      ]),
    );

    expect(error.code).toBe("KNOWLEDGE_ORGANIZATION_MISMATCH");
    expect(error.message).toContain("kb-invalid");
  });

  test("owner 模式不增加组织交集限制", () => {
    const access = resolveKnowledgeRuntimeAccessScope("owner", {});

    expect(() =>
      assertKnowledgeRuntimeBindingsInScope(access, [
        { id: "kb-1", organizationId: "org-1" },
        { id: "kb-2", organizationId: null },
        { id: "kb-3", organizationId: "org-2" },
      ]),
    ).not.toThrow();
  });
});
