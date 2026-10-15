import { describe, expect, test } from "bun:test";
import {
  buildPeriCapabilityMeta,
  isPeriTaskNotificationMethod,
  PERI_AGENT_EVENT_CAPABILITY,
  PERI_AGENT_EVENT_DONE_METHOD,
  PERI_AGENT_EVENT_METHOD,
  PERI_TOKEN_STATS_CAPABILITY,
  PERI_UNSTABLE_EVENT_CAPABILITY,
  PERI_UNSTABLE_EVENT_METHOD,
  PERI_USER_INPUT_QUEUE_CAPABILITY,
} from "../peri-task-capability";

describe("Peri Task capability", () => {
  // acp-link 始终声明已实现的 Peri token 明细、两个事件扩展与用户输入队列能力，
  // 避免宿主与 machine 状态分裂
  test("declares supported capabilities", () => {
    expect(buildPeriCapabilityMeta()).toEqual({
      [PERI_TOKEN_STATS_CAPABILITY]: true,
      [PERI_AGENT_EVENT_CAPABILITY]: true,
      [PERI_UNSTABLE_EVENT_CAPABILITY]: true,
      [PERI_USER_INPUT_QUEUE_CAPABILITY]: true,
    });
  });

  // method 白名单只放行三个已知 method，未知 Peri 控制事件不得透传
  test("whitelist only admits supported methods", () => {
    expect(isPeriTaskNotificationMethod(PERI_AGENT_EVENT_METHOD)).toBe(true);
    expect(isPeriTaskNotificationMethod(PERI_UNSTABLE_EVENT_METHOD)).toBe(true);
    // TurnDone 通知：协商 userInputQueue 后 peri 必发，是 steer run 唯一的 turn 终态来源；
    // 被白名单吞掉会让新 turn 永久停在 loading
    expect(isPeriTaskNotificationMethod(PERI_AGENT_EVENT_DONE_METHOD)).toBe(true);
    expect(isPeriTaskNotificationMethod("peri/unstable-event")).toBe(false);
    expect(isPeriTaskNotificationMethod("session/update")).toBe(false);
  });
});
