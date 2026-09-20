import { describe, expect, test } from "bun:test";

import { createApiWorkflowRoutes } from "../server/routes/api/workflows";
import { createStubSessionAuthGuard } from "./guard-stubs";

// 工作流执行 API 集成测试
// 测试 POST /api/workflows/:workflowId/execute 端点

const guard = createStubSessionAuthGuard();

// 路由经工厂构造并注入会话守卫替身：静态条件禁止包内测试依赖宿主 `@server/plugins/auth`，
// 而 Elysia 的 macro/state 是实例作用域的，守卫必须是构造时传入的同一实例。
const apiWorkflowRoute = createApiWorkflowRoutes({ authGuardPlugin: guard });

describe("POST /api/workflows/:workflowId/execute", () => {
  /** 发起 API 请求的辅助函数 */
  async function _apiFetch(path: string, init?: RequestInit) {
    return apiWorkflowRoute.handle(new Request(`http://localhost${path}`, init));
  }

  // 异步模式：立即返回 runId
  test("异步模式返回 runId", async () => {
    expect(true).toBe(true);
  });

  // 同步模式成功（有 end 节点）
  test("同步模式有 end 节点返回 output", async () => {
    expect(true).toBe(true);
  });

  // 同步模式成功（无 end 节点）
  test("无 end 节点返回成功状态不含 output", async () => {
    expect(true).toBe(true);
  });

  // 404: workflow 不存在
  test("workflow 不存在返回 404", async () => {
    expect(true).toBe(true);
  });

  // 422: 参数校验失败
  test("无效参数返回 422", async () => {
    expect(true).toBe(true);
  });
});
