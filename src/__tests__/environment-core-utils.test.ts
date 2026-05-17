import { describe, expect, it } from "bun:test";

// 测试 environment-core.ts 的纯函数：generateEnvSecret、toResponse、sanitizeResponse

const {
  generateEnvSecret,
  toResponse,
  sanitizeResponse,
} = await import("../services/environment-core");

// ── generateEnvSecret ──

describe("generateEnvSecret", () => {
  // 格式：env_secret_ + 48 hex 字符
  it("生成 env_secret_ 前缀的 secret", () => {
    const secret = generateEnvSecret();
    expect(secret).toMatch(/^env_secret_[a-f0-9]{48}$/);
  });

  it("每次生成不同的 secret", () => {
    const a = generateEnvSecret();
    const b = generateEnvSecret();
    expect(a).not.toBe(b);
  });
});

// ── toResponse ──

describe("toResponse", () => {
  // 完整字段转换
  it("将 EnvironmentRecord 转为 v1 响应格式", () => {
    const now = new Date();
    const result = toResponse({
      id: "env_123",
      machineName: "my-machine",
      directory: "/home/user/project",
      branch: "main",
      status: "active",
      username: "testuser",
      lastPollAt: now,
      workerType: "acp",
      capabilities: { max_sessions: 1 },
    } as any);

    expect(result.id).toBe("env_123");
    expect(result.machine_name).toBe("my-machine");
    expect(result.directory).toBe("/home/user/project");
    expect(result.branch).toBe("main");
    expect(result.status).toBe("active");
    expect(result.username).toBe("testuser");
    expect(result.last_poll_at).toBe(Math.floor(now.getTime() / 1000));
    expect(result.worker_type).toBe("acp");
    expect(result.capabilities).toEqual({ max_sessions: 1 });
  });

  // lastPollAt 为 null
  it("lastPollAt 为 null 时 last_poll_at 为 null", () => {
    const result = toResponse({
      id: "env_456",
      machineName: null,
      directory: null,
      branch: null,
      status: "idle",
      username: null,
      lastPollAt: null,
      workerType: "acp",
      capabilities: null,
    } as any);
    expect(result.last_poll_at).toBeNull();
  });

  // 时间戳取整（验证 Math.floor）
  it("时间戳使用 Math.floor 取整（非四舍五入）", () => {
    const ts = new Date("2026-05-16T12:34:56.789Z");
    const result = toResponse({
      id: "env_ts",
      machineName: null,
      directory: null,
      branch: null,
      status: "active",
      username: null,
      lastPollAt: ts,
      workerType: "acp",
      capabilities: null,
    } as any);
    expect(result.last_poll_at).toBe(Math.floor(ts.getTime() / 1000));
  });
});

// ── sanitizeResponse ──

describe("sanitizeResponse", () => {
  it("将 EnvironmentRecord 转为 Web API 响应格式", () => {
    const now = new Date();
    const result = sanitizeResponse({
      id: "env_789",
      name: "my-project",
      description: "A project",
      workspacePath: "/home/user/project",
      agentConfigId: "cfg_123",
      status: "idle",
      machineName: "my-machine",
      branch: "develop",
      autoStart: true,
      lastPollAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    expect(result.id).toBe("env_789");
    expect(result.name).toBe("my-project");
    expect(result.description).toBe("A project");
    expect(result.workspace_path).toBe("/home/user/project");
    expect(result.agent_config_id).toBe("cfg_123");
    expect(result.status).toBe("idle");
    expect(result.auto_start).toBe(true);
    expect(result.created_at).toBe(Math.floor(now.getTime() / 1000));
    expect(result.updated_at).toBe(Math.floor(now.getTime() / 1000));
  });

  // null 字段默认值
  it("null 字段使用合理的默认值", () => {
    const now = new Date();
    const result = sanitizeResponse({
      id: "env_null",
      name: null,
      description: null,
      workspacePath: null,
      agentConfigId: null,
      status: "idle",
      machineName: null,
      branch: null,
      autoStart: null,
      lastPollAt: null,
      createdAt: now,
      updatedAt: now,
    } as any);

    expect(result.description).toBeNull();
    expect(result.agent_config_id).toBeNull();
    expect(result.auto_start).toBe(false);
    expect(result.last_poll_at).toBeNull();
  });

  // 时间戳精度：带毫秒的 Date 不丢失精度
  it("毫秒精度时间戳正确转换为整数秒", () => {
    const ts = new Date("2026-05-17T08:30:45.678Z");
    const result = sanitizeResponse({
      id: "env_ms",
      name: "test",
      description: null,
      workspacePath: "/tmp",
      agentConfigId: null,
      status: "idle",
      machineName: null,
      branch: null,
      autoStart: false,
      lastPollAt: ts,
      createdAt: ts,
      updatedAt: ts,
    } as any);

    const expected = Math.floor(ts.getTime() / 1000);
    expect(result.last_poll_at).toBe(expected);
    expect(result.created_at).toBe(expected);
    expect(result.updated_at).toBe(expected);
  });
});
