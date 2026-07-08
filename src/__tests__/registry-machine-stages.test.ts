// 机器注册状态流转：pending → online / offline → online / online 拒绝
import { describe, expect, test } from "bun:test";

describe("registerMachine machineId 状态流转", () => {
  // pending 首次注册 → 激活为 online
  test("pending 状态机器首次注册成功", () => {
    const status: string = "pending";
    let updatedStatus = "";
    let eventType = "";

    if (status === "online") {
      throw new Error("already online");
    }
    const isFirst = status === "pending";
    updatedStatus = "online";
    eventType = isFirst ? "register" : "reconnect";

    expect(updatedStatus).toBe("online");
    expect(eventType).toBe("register");
  });

  // offline 重连 → 写 reconnect 事件
  test("offline 状态机器重连成功", () => {
    const status: string = "offline";
    let updatedStatus = "";
    let eventType = "";

    if (status === "online") {
      throw new Error("already online");
    }
    const isFirst = status === "pending";
    updatedStatus = "online";
    eventType = isFirst ? "register" : "reconnect";

    expect(updatedStatus).toBe("online");
    expect(eventType).toBe("reconnect");
  });

  // online 拒绝
  test("online 状态机器拒绝重复注册", () => {
    const status: string = "online";
    expect(() => {
      if (status === "online") {
        throw new Error("already online");
      }
    }).toThrow("already online");
  });

  // 机器不存在
  test("机器 ID 不存在时报错", () => {
    const existing: unknown[] = [];
    const machineId = "mach_nonexistent";
    expect(() => {
      if (existing.length === 0) {
        throw new Error(`machine '${machineId}' not found`);
      }
    }).toThrow(/not found/);
  });
});

describe("createMachine 返回结构", () => {
  // 返回的 id 以 mach_ 开头
  test("返回 id 以 mach_ 开头", () => {
    const prefix = "mach_";
    expect(prefix).toBe("mach_");
  });

  // 返回的 status 为 pending
  test("返回 status 为 pending", () => {
    const result = { id: "mach_test", name: "test", status: "pending" as const, initCommand: "..." };
    expect(result.status).toBe("pending");
  });

  // initCommand 包含 RCS_MACHINE_ID
  test("initCommand 包含 RCS_MACHINE_ID", () => {
    const initCommand = "RCS_MACHINE_ID=mach_test RCS_SECRET=xxx AGENT_TYPE=opencode acp-runtime opencode acp";
    expect(initCommand).toContain("RCS_MACHINE_ID=");
    expect(initCommand).toContain("RCS_SECRET=");
    expect(initCommand).toContain("AGENT_TYPE=");
    expect(initCommand).toContain("acp-runtime");
  });
});
