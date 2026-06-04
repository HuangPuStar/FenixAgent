import { beforeEach, describe, expect, mock, test } from "bun:test";
import { agentApi } from "../api/sdk";
import {
  canManageAgentSharing,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  getAgentOptionValue,
  isAgentWritable,
} from "../lib/agent-resource-access";
import type { ResourceAccess } from "../types/config";

const internalAccess: ResourceAccess = {
  ownership: "internal",
  sourceOrganizationId: "org-current",
  sourceOrganizationName: "Current Team",
  resourceUid: "agc-internal",
  resourceKey: "org-current/agc-internal",
  manageable: true,
  writable: true,
  publicReadable: false,
};

const externalAccess: ResourceAccess = {
  ownership: "external",
  sourceOrganizationId: "org-source",
  sourceOrganizationName: "Source Team",
  resourceUid: "agc-external",
  resourceKey: "org-source/agc-external",
  manageable: false,
  writable: false,
};

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true, data: { name: "shared-agent" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
});

describe("agent resource access frontend flow", () => {
  // 同名内部与外部 Agent 通过 resourceKey 稳定区分。
  test("同名 Agent 优先使用 resourceKey 作为 option value", () => {
    const internal = { id: "agc-internal", name: "shared-agent", resourceAccess: internalAccess };
    const external = { id: "agc-external", name: "shared-agent", resourceAccess: externalAccess };

    expect(getAgentOptionValue(internal)).toBe("org-current/agc-internal");
    expect(getAgentOptionValue(external)).toBe("org-source/agc-external");
  });

  // 打开配置详情时，共享 Agent 也应优先使用 resourceKey，避免同名资源冲突。
  test("共享 Agent 的配置入口优先使用 resourceKey", () => {
    const internal = { id: "agc-internal", name: "shared-agent", resourceAccess: internalAccess };
    const external = { id: "agc-external", name: "shared-agent", resourceAccess: externalAccess };

    expect(getAgentConfigLookupKey(internal)).toBe("org-current/agc-internal");
    expect(getAgentConfigLookupKey(external)).toBe("org-source/agc-external");
  });

  // 外部 Agent 的显示名附带来源组织。
  test("外部 Agent 展示来源组织", () => {
    expect(getAgentDisplayName({ id: "agc-external", name: "shared-agent", resourceAccess: externalAccess })).toBe(
      "Source Team/shared-agent",
    );
  });

  // 外部 Agent 不可写，也不能管理公开开关。
  test("外部 Agent 不可编辑也不可管理共享", () => {
    const external = { id: "agc-external", name: "shared-agent", resourceAccess: externalAccess };

    expect(isAgentWritable(external)).toBe(false);
    expect(canManageAgentSharing(external)).toBe(false);
  });

  // 公开开关仍通过原 agents set action 发送 publicReadable。
  test("公开开关 set action 携带 publicReadable", async () => {
    await agentApi.set("shared-agent", {
      prompt: "shared",
      publicReadable: true,
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      action: "set",
      name: "shared-agent",
      data: {
        prompt: "shared",
        publicReadable: true,
      },
    });
  });
});
