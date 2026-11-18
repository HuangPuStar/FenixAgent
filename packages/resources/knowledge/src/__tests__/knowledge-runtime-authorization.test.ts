import { describe, expect, test } from "bun:test";
import { moduleManifest } from "../../fenix.module";
import {
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

  // 委派模式只规范化并校验身份，跨组织授权交由外部门控。
  test("trusted-delegate 规范化运行身份", () => {
    expect(
      resolveKnowledgeRuntimeAccessScope("trusted-delegate", {
        userId: " user-1 ",
        organizationId: " org-1 ",
      }),
    ).toEqual({ mode: "trusted-delegate", trustedDelegate: true, userId: "user-1", organizationId: "org-1" });
  });
});
