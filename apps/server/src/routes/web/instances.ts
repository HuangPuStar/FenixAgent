import { getBoundAgentRuntime } from "@fenix/agent-runtime/runtime";
import {
  InstanceActivityListResponseSchema,
  InstanceActivityQuerySchema,
  SpawnInstanceFromEnvironmentRequestSchema,
  SpawnInstanceFromEnvironmentResponseSchema,
} from "@fenix/agent-runtime/server";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { authGuardPlugin } from "../../plugins/auth";

const app = new Elysia({ name: "web-instances" }).use(authGuardPlugin).model({
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

export default app;
