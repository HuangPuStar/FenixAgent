import { describe, expect, test } from "bun:test";
import type { MachineRecord } from "@/src/api/registry";
import {
  canOperateMachine,
  nameToSlug,
  parseLabels,
  readDefaultMachineId,
} from "@/src/pages/agent-panel/pages/agent-organizations-utils";

const MACHINE: MachineRecord = {
  id: "machine-1",
  organizationId: "org-1",
  userId: null,
  agentName: "opencode",
  name: "Runtime",
  status: "offline",
  machineInfo: null,
  labels: [],
  maxSessions: 1,
  heartbeatIntervalMs: 1000,
  lastHeartbeatAt: null,
  registeredAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("agent organization view utilities", () => {
  // 组织名称转换为 URL 标识时保留中文，并清理重复分隔符。
  test("creates a stable organization slug", () => {
    expect(nameToSlug("研发 中心 / Platform")).toBe("研发-中心-platform");
  });

  // 默认执行节点缺失或为空时必须回退到本地运行，避免展示不存在的机器。
  test("reads the configured default machine safely", () => {
    expect(readDefaultMachineId(undefined)).toBe("local");
    expect(readDefaultMachineId({ defaultEngine: { machineId: "machine-1" } })).toBe("machine-1");
  });

  // 机器操作同时受组织、成员身份和管理权限约束，跨组织记录不得暴露写操作。
  test("guards machine actions by organization and ownership", () => {
    expect(canOperateMachine(MACHINE, "org-1", "user-1", true)).toBe(true);
    expect(canOperateMachine(MACHINE, "org-2", "user-1", true)).toBe(false);
    expect(canOperateMachine({ ...MACHINE, userId: "user-2" }, "org-1", "user-1", true)).toBe(false);
  });

  // 标签输入按逗号拆分并过滤空项，保持提交给注册表 API 的数据干净。
  test("normalizes machine labels", () => {
    expect(parseLabels("sandbox, production, ,gpu")).toEqual(["sandbox", "production", "gpu"]);
  });
});
