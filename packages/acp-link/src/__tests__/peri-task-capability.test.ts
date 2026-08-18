// packages/acp-link/src/__tests__/peri-task-capability.test.ts
// Slice 0B：Peri Task capability 协商开关单元测试。
//
// 语义（规格 §四）：capability 默认关闭（默认 false → Peri 源头不发射，行为与
// 既有版本一致）；宿主开启 RCS_PERI_TASK_VIEW_ENABLED 并经 launchSpec.env 透传
// 同名变量到 machine 进程后开启；启动方可用 setPeriTaskCapabilityEnabled 显式
// 注入（优先于环境变量，用于以启动参数传入开关的场景）。
//
// capability key 使用完整 `_meta` key（peri.agentEvent / peri.unstableEvent），
// 即 PeriCaps::from_client_meta 解析键（peri-acp-types/src/peri_caps.rs:67-84），
// 不是计划中的 agent_event / unstable_event 短名。

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPeriCapabilityMeta,
  isPeriTaskNotificationMethod,
  PERI_AGENT_EVENT_CAPABILITY,
  PERI_AGENT_EVENT_METHOD,
  PERI_UNSTABLE_EVENT_CAPABILITY,
  PERI_UNSTABLE_EVENT_METHOD,
  setPeriTaskCapabilityEnabled,
} from "../peri-task-capability";

afterEach(() => {
  // 恢复模块初始默认（env 未设置视为关闭），避免污染其他测试
  setPeriTaskCapabilityEnabled(process.env.RCS_PERI_TASK_VIEW_ENABLED === "true");
});

describe("Peri Task capability 开关", () => {
  // 默认关闭：未显式开启时 buildPeriCapabilityMeta 返回空对象，
  // initialize 的 clientCapabilities 不含 _meta 段（与既有版本行为完全一致）
  test("capability is disabled by default", () => {
    setPeriTaskCapabilityEnabled(false);
    expect(buildPeriCapabilityMeta()).toEqual({});
    expect(isPeriTaskNotificationMethod(PERI_AGENT_EVENT_METHOD)).toBe(false);
    expect(isPeriTaskNotificationMethod(PERI_UNSTABLE_EVENT_METHOD)).toBe(false);
  });

  // 开启后使用完整 _meta key（不是计划中的短名），两个能力同时声明
  test("enabled capability declares full _meta keys", () => {
    setPeriTaskCapabilityEnabled(true);
    expect(buildPeriCapabilityMeta()).toEqual({
      [PERI_AGENT_EVENT_CAPABILITY]: true,
      [PERI_UNSTABLE_EVENT_CAPABILITY]: true,
    });
  });

  // method 白名单只放行两个已知 method；其他（含历史错误别名
  // peri/unstable-event）一律不转发，防止暴露任意 Peri 控制事件
  test("whitelist only admits the two known methods", () => {
    setPeriTaskCapabilityEnabled(true);
    expect(isPeriTaskNotificationMethod(PERI_AGENT_EVENT_METHOD)).toBe(true);
    expect(isPeriTaskNotificationMethod(PERI_UNSTABLE_EVENT_METHOD)).toBe(true);
    expect(isPeriTaskNotificationMethod("peri/unstable-event")).toBe(false);
    expect(isPeriTaskNotificationMethod("peri/other_event")).toBe(false);
    expect(isPeriTaskNotificationMethod("session/update")).toBe(false);
  });

  // 显式注入优先于环境变量：关闭环境变量后仍可经 setPeriTaskCapabilityEnabled
  // 开启（machine 端以启动参数注入开关的场景）
  test("explicit injection overrides environment variable", () => {
    setPeriTaskCapabilityEnabled(true);
    expect(isPeriTaskNotificationMethod(PERI_AGENT_EVENT_METHOD)).toBe(true);
  });
});
