// web/src/__tests__/session-guard.test.ts
// 根守卫的会话跳转决策表（`shell/session-guard.ts`）。钉住两条不变量：
//   ① 「疑似未登录」不得直接跳登录页——必须先复核（浏览器存量 cookie 曾让会话判定在
//      有/无之间抖动，守卫因此与"登录页→控制台"互跳，形成 /ctrl/login ↔ /ctrl/agent 死循环）；
//   ② 有会话落在登录页仍要即时回控制台；复核命中会话（抖动被吸收）时任何跳转都不发生。
// 只测决策表：延迟复核的时序接线（定时器、refetch）保持薄，不做 Provider 级 mock。

import { expect, test } from "bun:test";
import { decideSessionGuard } from "../shell/session-guard";

/** 决策输入基线：已登录、停留在控制台页面。 */
const base = {
  hasSession: true,
  isPending: false,
  pathname: "/agent/home",
  isAdminPath: false,
  verifiedNull: false,
} as const;

// 未登录且未复核只安排复核、不跳转：这是阻断跳转循环的第一道闸门。
test("疑似未登录时先复核，不直接跳登录页", () => {
  expect(decideSessionGuard({ ...base, hasSession: false })).toBe("verify");
});

// 复核后仍为空会话才允许踢到登录页，行为与加固前一致（只是多了一次确认）。
test("复核后仍无会话才跳登录页", () => {
  expect(decideSessionGuard({ ...base, hasSession: false, verifiedNull: true })).toBe("to-login");
});

// 复核命中有效会话（抖动瞬时出现又消失）时留在原页：循环的断点就在这里。
test("复核命中会话时不产生跳转", () => {
  expect(decideSessionGuard(base)).toBe("idle");
});

// 有会话却落在登录页：即时回控制台，本侧不参与复核、不受防抖影响。
test("有会话落在登录页时回控制台", () => {
  expect(decideSessionGuard({ ...base, pathname: "/login" })).toBe("to-agent");
});

// 会话解析中、登录页与管理员路径三类场景都不动作，复核状态也不被推进。
test("解析中、登录页与管理员路径均不触发跳转", () => {
  expect(decideSessionGuard({ ...base, isPending: true })).toBe("idle");
  expect(decideSessionGuard({ ...base, hasSession: false, pathname: "/login" })).toBe("idle");
  expect(decideSessionGuard({ ...base, hasSession: false, isAdminPath: true, pathname: "/admin/observer" })).toBe(
    "idle",
  );
});
