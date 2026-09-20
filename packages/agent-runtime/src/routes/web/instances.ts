/**
 * 控制台实例路由工厂：`/web/instances/**`（1.5c 从宿主 `apps/server/src/routes/web/instances.ts` 迁入）。
 *
 * 归属：实例生命周期的 owner 是本包（`agentInstanceService` / 运行编排），因此路由落在本包；
 * 宿主只保留注入守卫后的挂载。
 *
 * 取数方式与 `routes/web/control.ts` **不同**，这里经 `getBoundAgentRuntime()`（相对导入 `../../runtime`）
 * 而不是直引包内实现，判据是「该能力是否在运行 port 上」：
 * - 实例的生命周期动作（`stopInstanceRuntime` / `restartInstanceRuntime` / `deleteInstance`、
 *   `ensureInstance` / `getRuntimeSnapshot`）都在 `AgentRuntimePort` 上。port 是宿主编排层与用例的
 *   **唯一替换点**（`stubAgentRuntimePort`），直引包内模块函数等于给同一批能力开第二个替换点——
 *   正是 1.4 W3b 收敛掉的那种形态（用例此前靠 monkey-patch 包内单例）；
 * - 取绑定入口不会产生第二套运行状态：`createAgentRuntime()` 内部持有的都是本包模块级单例
 *   （实例服务、实例注册表、relay 连接表），多次构造等价。该判据同样解释了 `control.ts` 为什么直引：
 *   它用的是会话总线与仓储，不属运行 port 的能力面（总线另经 `session-event-bus-port` 由宿主注入）。
 *
 * 守卫由宿主注入（与 `/api/instances`、`/acp/*`、`/web/sessions/*` 同因）：Elysia 的 `macro` / `state`
 * 是实例作用域的，包内自建一份会让同一进程出现两套互不可见的认证状态。
 */

import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getBoundAgentRuntime } from "../../runtime";
import {
  InstanceActivityListResponseSchema,
  InstanceActivityQuerySchema,
  SpawnInstanceFromEnvironmentRequestSchema,
  SpawnInstanceFromEnvironmentResponseSchema,
} from "../../schemas/instance.schema";
import type { AgentRuntimeAuthDependencies } from "../dependencies";

/**
 * 构造 `/web/instances/**` 路由。
 *
 * 四个动作共用同一段归属校验（实例属于当前用户、其环境属于当前组织）；活跃度查询按组织过滤。
 */
export function createWebInstancesRoutes(deps: AgentRuntimeAuthDependencies) {
  const app = new Elysia({ name: "web-instances" }).use(deps.authGuardPlugin).model({
    "instance-activity-query": InstanceActivityQuerySchema,
    "instance-activity-list-response": InstanceActivityListResponseSchema,
    "spawn-instance-request": SpawnInstanceFromEnvironmentRequestSchema,
    "spawn-instance-response": SpawnInstanceFromEnvironmentResponseSchema,
  });

  /** GET /web/instances/activity — 查看当前 ACP 实例活跃度与空闲回收状态 */
  app.get(
    "/instances/activity",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, query, error }: any) => {
      if (query.all === true) {
        return error(403, {
          success: false,
          error: { code: "FORBIDDEN", message: "Cross-organization instance activity is not available" },
        });
      }
      const organizationId = store.authContext?.organizationId ?? store.user?.id;
      return {
        success: true as const,
        data: await getBoundAgentRuntime().listInstanceActivity(Date.now(), organizationId, query.showError === true),
      };
    },
    {
      sessionAuth: true,
      query: "instance-activity-query",
      response: {
        200: InstanceActivityListResponseSchema,
        403: WebErrSchema,
      },
      detail: {
        tags: ["Instances"],
        summary: "查看 ACP 实例活跃度",
        description:
          "返回当前组织下活跃实例的 ACP 连接观测数据；跨组织查询不对控制台用户开放，query `showError=true` 时额外返回 error 状态实例。",
      },
    },
  );

  /** POST /web/instances/from-environment — 为环境启动新实例 */
  app.post(
    "/instances/from-environment",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, body, error }: any) => {
      const user = store.user!;
      const authCtx = store.authContext!;
      const b = body as { environmentId: string };

      try {
        await getBoundAgentRuntime().getOwnedEnvironment(b.environmentId, authCtx.organizationId, user.id);
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as { code?: string }).code === "NOT_FOUND") {
          return error(404, { success: false, error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        throw err;
      }

      const runtime = getBoundAgentRuntime();
      const persistentInstance = await runtime.createInstance({
        environmentId: b.environmentId,
        ownerUserId: user.id,
        actorUserId: user.id,
        name: `instance-${crypto.randomUUID()}`,
      });
      await runtime.ensureInstanceRuntime(persistentInstance);
      return {
        success: true as const,
        data: {
          instanceUid: persistentInstance.id,
          environmentId: persistentInstance.environmentId,
          name: persistentInstance.name,
          status: runtime.getRuntimeSnapshot(persistentInstance.id).state,
          createdAt: persistentInstance.createdAt.toISOString(),
        },
      };
    },
    {
      sessionAuth: true,
      body: "spawn-instance-request",
      response: {
        200: "spawn-instance-response",
        404: WebErrSchema,
      },
      detail: {
        tags: ["Instances"],
        summary: "从环境启动实例",
        description: "基于指定环境创建并启动一个新的运行实例，返回实例的当前状态与关联信息。",
      },
    },
  );

  /** 校验实例与 Environment 均属于当前用户和组织。 */
  async function getOwnedInstanceForAction(instanceUid: string, organizationId: string, userId: string) {
    const runtime = getBoundAgentRuntime();
    const instance = await runtime.getOwnedInstance(instanceUid, userId);
    await runtime.getOwnedEnvironment(instance.environmentId, organizationId, userId);
    return instance;
  }

  /** POST /web/instances/:id/stop — 停止 runtime，保留持久 Instance。 */
  app.post(
    "/instances/:id/stop",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, error }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      try {
        const instance = await getOwnedInstanceForAction(params.id, authCtx.organizationId, user.id);
        await getBoundAgentRuntime().stopInstanceRuntime(instance, "strict");
        return { success: true as const, data: null };
      } catch (err: unknown) {
        const code = err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
        if (code === "INSTANCE_NOT_FOUND" || code === "NOT_FOUND") {
          return error(404, { success: false, error: { code: "NOT_FOUND", message: "Agent Instance not found" } });
        }
        throw err;
      }
    },
    {
      sessionAuth: true,
      response: {
        200: WebOkSchema(z.null().describe("实例停止成功后固定返回 null。")).describe("停止实例响应。"),
        404: WebErrSchema,
      },
      detail: {
        tags: ["Instances"],
        summary: "停止实例",
        description: "停止指定实例的 runtime，但保留持久 Instance，可再次进入或重启。",
      },
    },
  );

  /** POST /web/instances/:id/restart — 使用同一持久 Instance uid 重启 runtime。 */
  app.post(
    "/instances/:id/restart",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, error }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      try {
        const instance = await getOwnedInstanceForAction(params.id, authCtx.organizationId, user.id);
        await getBoundAgentRuntime().restartInstanceRuntime(instance);
        return { success: true as const, data: null };
      } catch (err: unknown) {
        const code = err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
        if (code === "INSTANCE_NOT_FOUND" || code === "NOT_FOUND") {
          return error(404, { success: false, error: { code: "NOT_FOUND", message: "Agent Instance not found" } });
        }
        throw err;
      }
    },
    {
      sessionAuth: true,
      response: {
        200: WebOkSchema(z.null().describe("实例重启成功后固定返回 null。")).describe("重启实例响应。"),
        404: WebErrSchema,
      },
      detail: {
        tags: ["Instances"],
        summary: "重启实例",
        description: "停止并使用同一持久 Instance uid 重新启动 runtime，Default 实例同样支持。",
      },
    },
  );

  /** DELETE /web/instances/:id — 停止并删除实例 */
  app.delete(
    "/instances/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, error }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      try {
        const instance = await getOwnedInstanceForAction(params.id, authCtx.organizationId, user.id);
        await getBoundAgentRuntime().deleteInstance(instance);
        return { success: true as const, data: null };
      } catch (err: unknown) {
        const code = err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
        if (code === "INSTANCE_NOT_FOUND" || code === "NOT_FOUND") {
          return error(404, { success: false, error: { code: "NOT_FOUND", message: "Agent Instance not found" } });
        }
        throw err;
      }
    },
    {
      sessionAuth: true,
      response: {
        200: WebOkSchema(z.null().describe("实例删除成功后固定返回 null。")).describe("删除实例响应。"),
        404: WebErrSchema,
      },
      detail: {
        tags: ["Instances"],
        summary: "删除实例",
        description: "停止并移除指定实例；对已停止或不存在的实例幂等返回成功（重复删除不报错）。",
      },
    },
  );

  return app;
}
