import { beforeEach, describe, expect, test } from "bun:test";
import { InstanceInfoSchema } from "../schemas/instance.schema";
import { toInstanceInfo } from "../services/instance";
import { resetAllStubs, stubCoreBootstrap } from "../test-utils/helpers";

describe("instance response mapping", () => {
  beforeEach(() => {
    resetAllStubs();
    // core-bootstrap 已在 setup-mocks.ts 中 preload mock；编排域分支需要可控的
    // getCoreRuntime（此处返回空实例列表，验证缺失展示字段时的默认值兜底）
    stubCoreBootstrap({
      getCoreRuntime: () => ({ listInstances: () => [] }),
    });
  });

  // 内部 SpawnedInstance 需要转换为对外 API 的 snake_case 结构
  test("maps spawned instance into schema-compatible response shape", () => {
    const result = toInstanceInfo({
      id: "inst_123",
      userId: "user_123",
      port: 8888,
      pid: null,
      status: "running",
      command: "",
      error: null,
      apiKey: "",
      createdAt: new Date("2026-06-11T06:30:37.757Z"),
      environmentId: "env_123",
      sessionId: undefined,
      instanceNumber: 1,
    });

    expect(result).toEqual({
      id: "inst_123",
      port: 8888,
      status: "running",
      error: null,
      group_id: "env_123",
      environment_id: "env_123",
      session_id: null,
      instance_number: 1,
      created_at: Math.floor(new Date("2026-06-11T06:30:37.757Z").getTime() / 1000),
    });
    expect(() => InstanceInfoSchema.parse(result)).not.toThrow();
  });

  // 编排域 Instance（仅 instanceId + status() 方法）缺少展示字段时应兜底默认值且保持 schema 兼容
  test("maps orchestration instance with fallback defaults for missing display fields", () => {
    const result = toInstanceInfo({
      instanceId: "inst_orch_never_exists",
      environmentId: "env_orch_1",
      status: () => "running",
    });

    expect(result).toEqual({
      id: "inst_orch_never_exists",
      port: 0,
      status: "running",
      error: null,
      group_id: "env_orch_1",
      environment_id: "env_orch_1",
      session_id: null,
      instance_number: 0,
      created_at: 0,
    });
    expect(() => InstanceInfoSchema.parse(result)).not.toThrow();
  });
});
