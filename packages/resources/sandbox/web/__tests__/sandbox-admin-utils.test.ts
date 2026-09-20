// web/__tests__/sandbox-admin-utils.test.ts
// 沙盒管理页纯函数的业务规则测试：健康检查结果归类与资源池草稿构造。
//
// 这两条规则都有「静默错」的代价：健康检查拿不到状态时若按成功提示，运维会以为 Server 正常；
// 复制池时若漏了深拷贝，编辑草稿会反向改掉列表里的原始池。故单测钉住。

import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";

import { createPoolDraft, formatHealthCheckResult, toClusterServerForm } from "../src/pages/admin/sandbox-admin-utils";

/**
 * 只保留「键 + 插值参数」的 t 替身：断言分支选择，不断言文案内容（文案归字典测试管）。
 * TFunction 的键空间重载无法由简单 stub 满足，故显式收窄，而不是逐字复刻 i18next 类型。
 */
const fakeT = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as unknown as TFunction;

describe("formatHealthCheckResult", () => {
  // 返回体不是对象（例如 4xx 裸响应）时必须归类为失败，不能提示成功。
  test("treats non-object responses as errors", () => {
    expect(formatHealthCheckResult("boom", fakeT)).toEqual({ message: "healthCheckNoStatus", variant: "error" });
    expect(formatHealthCheckResult(null, fakeT).variant).toBe("error");
  });

  // 有返回体但缺 healthStatus 同样算「无法判断」，按失败处理。
  test("treats missing healthStatus as an error", () => {
    expect(formatHealthCheckResult({ ok: true }, fakeT)).toEqual({ message: "healthCheckNoStatus", variant: "error" });
  });

  // healthy 走成功提示；status 非 healthy（unhealthy / degraded 等）一律走错误提示。
  test("maps healthy to success and everything else to error", () => {
    expect(formatHealthCheckResult({ healthStatus: "healthy" }, fakeT)).toEqual({
      message: 'healthCheckResult:{"status":"healthy"}',
      variant: "success",
    });
    expect(formatHealthCheckResult({ healthStatus: "unhealthy" }, fakeT).variant).toBe("error");
  });

  // 后端回传 lastError 时提示必须带上原因，运维据此定位而不必再翻日志。
  test("includes lastError in the message when present", () => {
    expect(formatHealthCheckResult({ healthStatus: "unhealthy", lastError: "connect timeout" }, fakeT)).toEqual({
      message: 'healthCheckResultWithError:{"status":"unhealthy","error":"connect timeout"}',
      variant: "error",
    });
    // 空字符串视为「没有原因」，退回无 error 的文案而不是显示空括号。
    expect(formatHealthCheckResult({ healthStatus: "healthy", lastError: "" }, fakeT).message).toBe(
      'healthCheckResult:{"status":"healthy"}',
    );
  });
});

describe("createPoolDraft", () => {
  // 无模板时给空白新建：id/name 空、provider 用集群默认值，交由用户填写。
  test("builds an empty draft without a template", () => {
    const draft = createPoolDraft(undefined, " 副本");
    expect(draft.id).toBe("");
    expect(draft.name).toBe("");
    expect(draft.providerKey).toBe("opensandbox-cluster");
    expect(draft.createdAt).toBe("");
  });

  // 复制池必须改 id（主键不能冲突）并在名称上标记为副本。
  test("duplicates a pool with a copy suffix", () => {
    const draft = createPoolDraft(
      {
        id: "pool-1",
        name: "pool",
        organizationId: "org-1",
        organizationName: null,
        providerKey: "opensandbox-cluster",
        image: "img:1",
        defaultResources: { cpu: 4, memoryMb: 1024, diskGb: 5, gpuCount: 0, environment: {}, volumes: [] },
        extra: { region: "cn" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      " 副本",
    );
    expect(draft.id).toBe("pool-1-copy");
    expect(draft.name).toBe("pool 副本");
    // createdAt 置空：草稿保存时以它区分「新建」与「更新」。
    expect(draft.createdAt).toBe("");
  });

  // 草稿是深拷贝：改草稿的嵌套对象不得影响源池，否则列表会显示未保存的编辑结果。
  test("deep clones nested resources and extra", () => {
    const source = {
      id: "pool-1",
      name: "pool",
      organizationId: null,
      organizationName: null,
      providerKey: "opensandbox-cluster",
      image: "img:1",
      defaultResources: { cpu: 4, memoryMb: 1024, diskGb: 5, gpuCount: 0, environment: {}, volumes: [] },
      extra: { region: "cn" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const draft = createPoolDraft(source, " 副本");
    expect(draft.defaultResources).not.toBe(source.defaultResources);
    expect(draft.extra).not.toBe(source.extra);
    expect(draft.defaultResources).toEqual(source.defaultResources);
  });
});

describe("toClusterServerForm", () => {
  // API 的 camelCase → 表单的 snake_case（提交时原样回传后端），字段不得丢。
  test("maps api entity fields to the form model", () => {
    expect(
      toClusterServerForm({
        id: "server-1",
        poolId: "pool-1",
        name: "s1",
        baseUrl: "http://host:8080",
        workspaceRoot: "/workspaces",
        maxSandboxes: 10,
        status: "active",
        transportMode: "direct",
        routeHost: null,
        healthStatus: "healthy",
        lastHealthAt: null,
        lastError: null,
        currentSandboxes: 0,
      }),
    ).toEqual({
      id: "server-1",
      pool_id: "pool-1",
      name: "s1",
      base_url: "http://host:8080",
      workspace_root: "/workspaces",
      max_sandboxes: 10,
      status: "active",
      transport_mode: "direct",
    });
  });
});
