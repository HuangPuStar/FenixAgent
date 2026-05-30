import { describe, expect, test } from "bun:test";
import type { ServerConfig } from "../server";

describe("ServerConfig 接受客户端模式字段", () => {
  test("config 包含 rcsUrl, rcsSecret, tenantId, userId, labels", () => {
    const config: ServerConfig = {
      port: 9315,
      host: "localhost",
      command: "opencode",
      args: [],
      cwd: "/tmp",
      rcsUrl: "ws://localhost:3000",
      rcsSecret: "test-secret",
      tenantId: "org1",
      userId: "u1",
      labels: ["gpu", "us-east"],
    };
    expect(config.rcsUrl).toBe("ws://localhost:3000");
    expect(config.rcsSecret).toBe("test-secret");
    expect(config.tenantId).toBe("org1");
    expect(config.userId).toBe("u1");
    expect(config.labels).toEqual(["gpu", "us-east"]);
  });
});

describe("buildRegisterMessage 消息格式正确", () => {
  test("消息包含所有必需字段", async () => {
    const { buildRegisterMessage } = await import("../server");
    const config: ServerConfig = {
      port: 9315,
      host: "localhost",
      command: "opencode",
      args: [],
      cwd: "/tmp",
      labels: ["gpu"],
      tenantId: "t1",
      userId: "u1",
    };
    const msg = buildRegisterMessage(config) as Record<string, unknown>;
    expect(msg.type).toBe("register");
    expect(msg.agent_name).toBe("opencode");
    expect(msg.labels).toEqual(["gpu"]);
    expect(msg.tenant_id).toBe("t1");
    expect(msg.user_id).toBe("u1");
    expect(msg.heartbeat_interval_ms).toBe(30000);
    expect(msg.max_sessions).toBe(5);
    const mi = msg.machine_info as Record<string, unknown>;
    expect(typeof mi.hostname).toBe("string");
    expect(typeof mi.ip).toBe("string");
    expect(typeof mi.os).toBe("string");
    expect(typeof mi.arch).toBe("string");
  });
});

describe("buildRegisterMessage 默认值", () => {
  test("labels 未指定时返回空数组", async () => {
    const { buildRegisterMessage } = await import("../server");
    const config: ServerConfig = {
      port: 9315,
      host: "localhost",
      command: "echo",
      args: [],
      cwd: "/tmp",
    };
    const msg = buildRegisterMessage(config) as Record<string, unknown>;
    expect(msg.labels).toEqual([]);
  });

  test("tenantId/userId 未指定时返回 null", async () => {
    const { buildRegisterMessage } = await import("../server");
    const config: ServerConfig = {
      port: 9315,
      host: "localhost",
      command: "echo",
      args: [],
      cwd: "/tmp",
    };
    const msg = buildRegisterMessage(config) as Record<string, unknown>;
    expect(msg.tenant_id).toBeNull();
    expect(msg.user_id).toBeNull();
  });
});

describe("buildRegisterMessage 机器信息", () => {
  test("machine_info 非空", async () => {
    const { buildRegisterMessage } = await import("../server");
    const config: ServerConfig = {
      port: 9315,
      host: "localhost",
      command: "echo",
      args: [],
      cwd: "/tmp",
    };
    const msg = buildRegisterMessage(config) as Record<string, unknown>;
    const mi = msg.machine_info as Record<string, unknown>;
    expect(mi.hostname).toBeTruthy();
    expect(typeof mi.hostname).toBe("string");
    expect((mi.hostname as string).length).toBeGreaterThan(0);
    expect(mi.os).toBeTruthy();
    expect(mi.arch).toBeTruthy();
  });
});

describe("createAcpClient rcsUrl 为空时抛错", () => {
  test("缺少 rcsUrl 时抛出 Error", async () => {
    const { createAcpClient } = await import("../server");
    expect(() =>
      createAcpClient({
        port: 9315,
        host: "localhost",
        command: "echo",
        args: [],
        cwd: "/tmp",
      }),
    ).toThrow("rcsUrl");
  });
});
