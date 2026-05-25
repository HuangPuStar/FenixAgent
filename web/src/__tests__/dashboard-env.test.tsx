import { describe, expect, test } from "bun:test";
// SDK imports
import { envApi } from "../api/sdk";
// Component imports
import { Dashboard } from "../pages/Dashboard";
// Type imports
import type { CreateEnvironmentRequest, Environment, EnvironmentDetail, UpdateEnvironmentRequest } from "../types";

describe("Dashboard Environment Management - Exports", () => {
  // 测试类型正确导出
  test("Environment types are exported correctly", () => {
    const env: Environment = {
      id: "test",
      name: "test-env",
      description: null,
      workspace_path: "/tmp",
      agent_name: null,
      agent_config_id: null,
      status: "idle",
      machine_name: null,
      branch: null,
      auto_start: false,
      last_poll_at: null,
      created_at: 0,
      updated_at: 0,
    };
    expect(env.id).toBe("test");

    const detail: EnvironmentDetail = {
      ...env,
      secret: "env_secret_test",
      capabilities: null,
      worker_type: "acp",
      max_sessions: 1,
    };
    expect(detail.secret).toBe("env_secret_test");

    const createReq: CreateEnvironmentRequest = {
      name: "new-env",
      workspacePath: "/tmp/new",
      agentConfigId: "agent-config-uuid",
    };
    expect(createReq.name).toBe("new-env");

    const updateReq: UpdateEnvironmentRequest = {
      description: "updated",
      agentConfigId: null,
    };
    expect(updateReq.description).toBe("updated");
  });

  // 测试 SDK envApi 正确导出
  test("SDK envApi is exported", () => {
    expect(envApi).toBeDefined();
    expect(typeof envApi.list).toBe("function");
  });

  // 测试 Dashboard 组件是函数
  test("Dashboard component is a function", () => {
    expect(typeof Dashboard).toBe("function");
  });
});
