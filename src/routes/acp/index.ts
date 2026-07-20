import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import { AcpAgentListResponseSchema } from "../../schemas";

/** Response shape for an ACP agent */
function toAcpAgentResponse(env: NonNullable<Awaited<ReturnType<typeof environmentRepo.getById>>>) {
  return {
    id: env.id,
    agent_name: env.machineName,
    status: (env.status === "active" ? "online" : "offline") as "online" | "offline",
    max_sessions: env.maxSessions,
    last_seen_at: env.lastPollAt ? env.lastPollAt.getTime() / 1000 : null,
    created_at: env.createdAt.getTime() / 1000,
  };
}

const app = new Elysia({ name: "acp", prefix: "/acp" })
  .use(authGuardPlugin)
  .model({
    "acp-agent-list-response": AcpAgentListResponseSchema,
  })

  /** GET /acp/agents — List current user's team ACP agents */
  .get(
    "/agents",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema 下的类型推断过于严格
    async ({ store }: any) => {
      const authCtx = store.authContext;
      const orgId = authCtx?.organizationId ?? store.user!.id;
      const teamEnvs = await environmentRepo.listByOrganizationId(orgId);
      const acpEnvs = teamEnvs.filter((e) => e.workerType === "acp");
      return acpEnvs.map((a) => toAcpAgentResponse(a));
    },
    {
      sessionAuth: true,
      response: "acp-agent-list-response",
      detail: {
        tags: ["ACP"],
        summary: "获取 ACP Agent 列表",
        description: "返回当前组织下所有使用 ACP worker 的环境列表及在线状态摘要。",
      },
    },
  );

export default app;
