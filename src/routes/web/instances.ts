import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  DeleteInstanceResponseSchema,
  InstanceActivityListResponseSchema,
  SpawnInstanceFromEnvironmentRequestSchema,
  SpawnInstanceFromEnvironmentResponseSchema,
} from "../../schemas/instance.schema";
import { listInstanceActivitySnapshots } from "../../services/acp-idle-monitor";
import { getCoreRuntime } from "../../services/core-bootstrap";
import { getOwnedEnvironment } from "../../services/environment";
import { spawnInstanceFromEnvironment, stopInstance, toInstanceInfo } from "../../services/instance";

const app = new Elysia({ name: "web-instances" }).use(authGuardPlugin).model({
  "instance-activity-list-response": InstanceActivityListResponseSchema,
  "delete-instance-response": DeleteInstanceResponseSchema,
  "spawn-instance-request": SpawnInstanceFromEnvironmentRequestSchema,
  "spawn-instance-response": SpawnInstanceFromEnvironmentResponseSchema,
});

/** GET /web/instances/activity — 查看当前 ACP 实例活跃度与空闲回收状态 */
app.get(
  "/instances/activity",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    return listInstanceActivitySnapshots(Date.now(), authCtx.organizationId);
  },
  {
    sessionAuth: true,
    response: "instance-activity-list-response",
    detail: {
      tags: ["Instances"],
      summary: "查看 ACP 实例活跃度",
      description:
        "返回当前组织下活跃实例的 ACP 连接观测数据，包括最近业务活跃时间、relay 数量、空闲时长，以及是否满足空闲回收或无 ACP 活动硬超时回收条件。",
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
      await getOwnedEnvironment(b.environmentId, authCtx.organizationId, user.id);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "NOT_FOUND") {
        return error(404, { error: { type: "NOT_FOUND", message: (err as Error).message } });
      }
      throw err;
    }

    const instance = await spawnInstanceFromEnvironment(user.id, b.environmentId);
    return { success: true as const, data: toInstanceInfo(instance) };
  },
  {
    sessionAuth: true,
    body: "spawn-instance-request",
    response: "spawn-instance-response",
    detail: {
      tags: ["Instances"],
      summary: "从环境启动实例",
      description: "基于指定环境创建并启动一个新的运行实例，返回实例的当前状态与关联信息。",
    },
  },
);

/** DELETE /web/instances/:id — 停止并删除实例 */
app.delete(
  "/instances/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const result = await stopInstance(params.id, authCtx.organizationId);

    if (!result.ok) {
      const isAlreadyStopped = result.error === "Already stopped";
      if (isAlreadyStopped) {
        getCoreRuntime().deleteInstance(params.id);
        return { success: true as const, data: { ok: true as const } };
      }
      const status = result.error === "Instance not found" ? 404 : 403;
      const type = status === 404 ? "NOT_FOUND" : "forbidden";
      return error(status, { error: { type, message: result.error! } });
    }

    getCoreRuntime().deleteInstance(params.id);
    return { success: true as const, data: { ok: true as const } };
  },
  {
    sessionAuth: true,
    response: "delete-instance-response",
    detail: {
      tags: ["Instances"],
      summary: "删除实例",
      description: "停止并移除指定实例；如果实例已停止，会执行一次清理并返回成功。",
    },
  },
);

export default app;
