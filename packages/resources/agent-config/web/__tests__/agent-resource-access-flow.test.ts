import { beforeEach, describe, expect, mock, test } from "bun:test";
import { agentApi } from "../api/agents";
import {
  type AgentResourceLike,
  canManageAgentSharing,
  getAgentAccessBadgeKey,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  isAgentWritable,
  isExternalAgent,
} from "../lib/agent-resource-access";

/** 视图字段子集：仅供用例构造 `/web` 响应形状，断言不依赖未列出的字段。 */
type AgentViewFields = Pick<AgentResourceLike, "scope" | "access" | "organizationName">;

/** 本组织 Agent 的 `/web` 详情视图字段：归属当前组织且可写。 */
const internalFields = {
  scope: { organizationId: "org-current", ownerUserId: "user-1", visibility: "private" },
  access: { actions: ["read", "create", "update", "delete", "use"] },
  organizationName: "Current Team",
} satisfies AgentViewFields;

/** 共享来源 Agent 的 `/web` 详情视图字段：归属其他组织且只有读动作。 */
const externalFields = {
  scope: { organizationId: "org-source", visibility: "public" },
  access: { actions: ["read"] },
  organizationName: "Source Team",
} satisfies AgentViewFields;

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
  // 同名内部与外部 Agent 通过归属组织 + 资源 id 推导出的资源键稳定区分。
  test("同名 Agent 的详情查找键包含归属组织", () => {
    const internal = { id: "agc-internal", name: "shared-agent", ...internalFields };
    const external = { id: "agc-external", name: "shared-agent", ...externalFields };

    expect(getAgentConfigLookupKey(internal)).toBe("org-current/agc-internal");
    expect(getAgentConfigLookupKey(external)).toBe("org-source/agc-external");
  });

  // 归属组织缺失（个人资源）时退回资源名，保证请求仍能定位到资源。
  test("缺失归属范围时查找键退回资源名", () => {
    expect(getAgentConfigLookupKey({ id: "agc-solo", name: "shared-agent" })).toBe("shared-agent");
  });

  // 展示名以归属组织限定（与 mcp / skill 同名资源保持一致），后端省略 organizationName 时退回裸资源名。
  test("展示名按归属组织限定并在缺失时退回资源名", () => {
    expect(getAgentDisplayName({ id: "agc-external", name: "shared-agent", ...externalFields })).toBe(
      "Source Team/shared-agent",
    );
    expect(getAgentDisplayName({ id: "agc-internal", name: "shared-agent", ...internalFields })).toBe(
      "Current Team/shared-agent",
    );
    // 个人资源没有归属组织，名录不可用时也不会补空串前缀。
    expect(getAgentDisplayName({ id: "agc-solo", name: "shared-agent" })).toBe("shared-agent");
  });

  // 授权判断只看 scope 与 access.actions：只读的外部 Agent 不可编辑也不可管理共享。
  test("外部 Agent 不可编辑也不可管理共享", () => {
    const external = { id: "agc-external", name: "shared-agent", ...externalFields };

    expect(isExternalAgent(external, "org-current")).toBe(true);
    expect(isExternalAgent(external, "org-source")).toBe(false);
    expect(isExternalAgent(external)).toBe(false);
    expect(isAgentWritable(external)).toBe(false);
    expect(canManageAgentSharing(external)).toBe(false);
    expect(getAgentAccessBadgeKey(external, "org-current")).toBe("resource.external");
  });

  // 缺失动作集合时保守降级为不可写，避免旧缓存或不完整响应造成越权展示。
  test("缺失动作集合时按不可写降级", () => {
    expect(isAgentWritable({ id: "agc-1", name: "own" })).toBe(false);
    expect(getAgentAccessBadgeKey({ id: "agc-1", name: "own" })).toBe("resource.internal");
  });

  // 公开开关改为走独立 PUT 接口，但仍保持 data 结构稳定。
  test("公开开关 PUT 请求携带 publicReadable", async () => {
    await agentApi.set("shared-agent", {
      prompt: "shared",
      publicReadable: true,
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toContain("/web/config/agents");
    expect(call[0]).toContain("name=shared-agent");
    expect(call[1].method).toBe("PUT");
    const body = JSON.parse(call[1].body);
    // 新 agentApi.set 将 data 包装为 { data: {...} } 发送
    expect(body).toEqual({
      data: {
        prompt: "shared",
        publicReadable: true,
      },
    });
  });
});
