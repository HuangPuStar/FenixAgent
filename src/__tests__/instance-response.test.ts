import { describe, expect, test } from "bun:test";
import { InstanceInfoSchema } from "../schemas/instance.schema";
import { toInstanceInfo } from "../services/instance";

describe("instance response mapping", () => {
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
});
