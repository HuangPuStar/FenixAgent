import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "../errors";
import type { EnvironmentRecord } from "../repositories/environment";
import {
  generateEnvSecret,
  getOwnedEnvironment,
  sanitizeResponse,
  toResponse,
  validateWorkspacePath,
} from "../services/environment-core";
import { normalizePayload } from "../services/transport";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";

function environment(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: "env-1",
    name: "environment",
    description: null,
    workspacePath: "/workspace/env-1",
    agentConfigId: null,
    secret: "env-secret",
    machineName: null,
    directory: "/workspace/env-1",
    branch: null,
    gitRepoUrl: null,
    workerType: "local",
    capabilities: null,
    status: "ready",
    username: null,
    userId: "user-a",
    organizationId: "org-a",
    autoStart: false,
    lastPollAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

beforeEach(() => {
  resetAllStubs();
});

afterEach(() => {
  resetAllStubs();
});

describe("environment-core 的隔离、失败与响应边界", () => {
  // 相对路径不能作为服务端 workspace，防止调用方逃逸出受控根目录。
  test("拒绝相对 workspace 路径", () => {
    expect(validateWorkspacePath("relative/workspace")).toBe("workspace 路径必须是绝对路径");
  });

  // 系统根目录绝不能作为用户 workspace。
  test("拒绝系统根目录", () => {
    expect(validateWorkspacePath("/")).toContain("不允许使用系统目录");
  });

  // /etc 子目录也属于受保护的宿主目录。
  test("拒绝 etc 子目录", () => {
    expect(validateWorkspacePath("/etc/fenix")).toContain("不允许使用系统目录下的路径");
  });

  // /var 子目录可能含运行时状态，不能被环境直接使用。
  test("拒绝 var 子目录", () => {
    expect(validateWorkspacePath("/var/lib/fenix")).toContain("不允许使用系统目录下的路径");
  });

  // /root 子目录不可暴露给普通环境。
  test("拒绝 root 子目录", () => {
    expect(validateWorkspacePath("/root/project")).toContain("不允许使用系统目录下的路径");
  });

  // 非系统绝对路径是合法的 workspace 候选路径。
  test("接受普通绝对路径", () => {
    expect(validateWorkspacePath("/Users/test/workspace")).toBeNull();
  });

  // 规范化后的系统路径不能绕过前缀限制。
  test("规范化后仍拒绝系统路径", () => {
    expect(validateWorkspacePath("/tmp/../etc/fenix")).toContain("不允许使用系统目录下的路径");
  });

  // secret 具有可识别前缀，便于边界层识别其用途。
  test("生成的环境 secret 带固定前缀", () => {
    expect(generateEnvSecret()).toStartWith("env_secret_");
  });

  // 连续 secret 必须具备独立随机性，不能复用进程状态。
  test("连续生成的环境 secret 不相同", () => {
    expect(generateEnvSecret()).not.toBe(generateEnvSecret());
  });

  // 不存在的环境以 404 表示，避免执行后续操作。
  test("缺失环境返回 NotFoundError", async () => {
    stubEnvironmentRepo({ getById: async () => null });
    await expect(getOwnedEnvironment("env-1", "org-a", "user-a")).rejects.toThrow(NotFoundError);
  });

  // 跨组织环境必须对调用者隐藏。
  test("其他组织环境返回 NotFoundError", async () => {
    stubEnvironmentRepo({ getById: async () => ({ organizationId: "org-b" }) });
    await expect(getOwnedEnvironment("env-1", "org-a", "user-a")).rejects.toThrow(NotFoundError);
  });

  // Agent runtime 属于其创建者，其他用户即使同组织也不可探测。
  test("非所有者无法读取 Agent runtime", async () => {
    stubEnvironmentRepo({
      getById: async () => ({ organizationId: "org-a", userId: "owner", agentConfigId: "agent-1" }),
    });
    await expect(getOwnedEnvironment("env-1", "org-a", "visitor")).rejects.toThrow(NotFoundError);
  });

  // member 对已存在环境写操作必须显式被拒绝。
  test("member 写操作返回 ForbiddenError", async () => {
    stubEnvironmentRepo({ getById: async () => ({ organizationId: "org-a", userId: "user-a", agentConfigId: null }) });
    await expect(getOwnedEnvironment("env-1", "org-a", "user-a", "member")).rejects.toThrow(ForbiddenError);
  });

  // owner 写操作可以取得已授权环境。
  test("owner 写操作返回环境记录", async () => {
    const env = environment({ id: "env-1", organizationId: "org-a", userId: "user-a", agentConfigId: null });
    stubEnvironmentRepo({ getById: async () => env });
    await expect(getOwnedEnvironment("env-1", "org-a", "user-a", "owner")).resolves.toBe(env);
  });

  // admin 写操作与 owner 具有相同授权语义。
  test("admin 写操作返回环境记录", async () => {
    stubEnvironmentRepo({ getById: async () => ({ organizationId: "org-a", userId: "user-a", agentConfigId: null }) });
    await expect(getOwnedEnvironment("env-1", "org-a", "user-a", "admin")).resolves.toMatchObject({
      organizationId: "org-a",
    });
  });

  // 只读调用不传角色时保持兼容性。
  test("未声明写角色的读取允许通过", async () => {
    stubEnvironmentRepo({ getById: async () => ({ organizationId: "org-a", userId: "user-a", agentConfigId: null }) });
    await expect(getOwnedEnvironment("env-1", "org-a")).resolves.toMatchObject({ organizationId: "org-a" });
  });

  // v1 DTO 必须将 Date 转为 Unix 秒。
  test("v1 响应转换轮询时间为 Unix 秒", () => {
    const result = toResponse(
      environment({
        machineName: "m",
        workspacePath: "/w",
        branch: "main",
        status: "ready",
        username: "u",
        lastPollAt: new Date("2024-01-01T00:00:00Z"),
        workerType: "local",
        capabilities: {},
      }),
    );
    expect(result.last_poll_at).toBe(1704067200);
  });

  // v1 DTO 对空轮询时间使用 null。
  test("v1 响应保留空轮询时间", () => {
    const result = toResponse(
      environment({
        machineName: "m",
        workspacePath: "/w",
        branch: "main",
        status: "ready",
        username: "u",
        lastPollAt: null,
        workerType: "local",
        capabilities: {},
      }),
    );
    expect(result.last_poll_at).toBeNull();
  });

  // Web DTO 统一缺失的可选字段，避免前端出现三态歧义。
  test("Web 响应将缺失可选字段规范化", () => {
    const result = sanitizeResponse(
      environment({
        name: "dev",
        workspacePath: "/w",
        status: "ready",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    );
    expect(result).toMatchObject({
      description: null,
      agent_config_id: null,
      machine_name: null,
      branch: null,
      auto_start: false,
      last_poll_at: null,
    });
  });
});

describe("transport payload 的失败与兼容边界", () => {
  // null payload 必须稳定规范化为空文本。
  test("null payload 转为空文本", () => {
    expect(normalizePayload("assistant", null)).toMatchObject({ content: "", raw: null });
  });
  // 原始字符串作为兼容输入必须保留。
  test("字符串 payload 转为文本", () => {
    expect(normalizePayload("assistant", "hello")).toMatchObject({ content: "hello", raw: "hello" });
  });
  // 直接 content 字段优先于嵌套消息。
  test("直接 content 优先", () => {
    expect(normalizePayload("assistant", { content: "direct", message: { content: "nested" } }).content).toBe("direct");
  });
  // 子进程消息格式可从 message.content 提取文本。
  test("读取嵌套 message content", () => {
    expect(normalizePayload("assistant", { message: { content: "nested" } }).content).toBe("nested");
  });
  // 流式文本块按顺序拼接。
  test("拼接文本块", () => {
    expect(
      normalizePayload("assistant", {
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      }).content,
    ).toBe("ab");
  });
  // 非文本块不得污染聊天正文。
  test("忽略非文本块", () => {
    expect(normalizePayload("assistant", { message: { content: [{ type: "image", text: "secret" }] } }).content).toBe(
      "",
    );
  });
  // 未知对象保持可审计 raw 但不猜测内容。
  test("未知对象不猜测文本", () => {
    expect(normalizePayload("assistant", { value: 1 })).toMatchObject({ content: "" });
  });
  // uuid 为空时不应被视为有效事件标识。
  test("空 uuid 不被保留", () => {
    expect(normalizePayload("assistant", { uuid: "" }).uuid).toBeUndefined();
  });
  // 非空 uuid 需透传给去重消费者。
  test("透传 uuid", () => {
    expect(normalizePayload("assistant", { uuid: "u-1" }).uuid).toBe("u-1");
  });
  // permission 的 false 是有效值，不能被 truthy 判断吞掉。
  test("保留拒绝 permission 结果", () => {
    expect(normalizePayload("permission", { approved: false }).approved).toBe(false);
  });
  // task_state 仅透传数组任务，拒绝不完整的标量。
  test("task_state 保留任务数组", () => {
    expect(normalizePayload("task_state", { tasks: [{ id: "t" }] }).tasks).toEqual([{ id: "t" }]);
  });
  // tool name 的 name 别名保持旧 Agent 兼容。
  test("tool name 别名归一化", () => {
    expect(normalizePayload("tool", { name: "read" }).tool_name).toBe("read");
  });
  // input 别名需要归一化到 tool_input。
  test("tool input 别名归一化", () => {
    expect(normalizePayload("tool", { input: { path: "a" } }).tool_input).toEqual({ path: "a" });
  });
});
