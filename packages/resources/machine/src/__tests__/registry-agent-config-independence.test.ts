import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { machine, registryEvent } from "../../db/schema";
import { resetMachineAgentConfigPortForTest } from "../server/agent-config-port";
import { registerMachine } from "../server/services/registry";
import { initializeMachineModuleConfig } from "../server/testing";

beforeEach(() => {
  resetAllStubs();
  resetMachineAgentConfigPortForTest();
  initializeMachineModuleConfig();
});

afterEach(() => {
  resetAllStubs();
  resetMachineAgentConfigPortForTest();
});

describe("机器注册不依赖 AgentConfig", () => {
  for (const status of ["pending", "offline", "online"] as const) {
    // 引擎名不代表 Agent 配置身份，注册与重连只更新机器状态并记录生命周期事件。
    test(`${status} 机器连接无需 AgentConfig 端口`, async () => {
      const updates: Record<string, unknown>[] = [];
      const events: Record<string, unknown>[] = [];
      stubDb({
        select: () => ({
          from: (table: unknown) => {
            expect(table).toBe(machine);
            return { where: () => ({ limit: async () => [{ id: "mach-engine", status }] }) };
          },
        }),
        update: (table: unknown) => {
          expect(table).toBe(machine);
          return {
            set: (values: Record<string, unknown>) => ({ where: async () => updates.push(values) }),
          };
        },
        insert: (table: unknown) => {
          expect(table).toBe(registryEvent);
          return { values: async (values: Record<string, unknown>) => events.push(values) };
        },
      });

      const result = await registerMachine({ machineId: "mach-engine", agentName: "opencode", tenantId: "org-a" });
      expect(result).toEqual({ id: "mach-engine", isNew: status === "pending" });
      expect(updates).toEqual([{ status: "online", lastHeartbeatAt: expect.any(Date), updatedAt: expect.any(Date) }]);
      expect(events).toEqual([
        {
          id: expect.any(String),
          machineId: "mach-engine",
          type: status === "pending" ? "register" : "reconnect",
          detail: {},
        },
      ]);
    });
  }
});
