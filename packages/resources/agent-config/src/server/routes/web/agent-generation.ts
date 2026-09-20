import { type ActorContext, WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { z } from "zod/v4";
import { AgentGenerationResponseSchema } from "../../schemas/agent-generation.schema";
import { generateAgentConfig, isGenerationConfigured } from "../../services/agent-generation";
import type { WebAgentConfigRouteDependencies } from "../dependencies";
import { buildWebErrorBody } from "./config/agent-route-support";

const GenerationBodySchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
});

/**
 * `/web/agent-generation` — Agent 智能生成。
 *
 * 改为工厂（CE 阶段 2 任务 1.3）：守卫由宿主注入。错误体改用包内 `buildWebErrorBody`，不再经宿主
 * `@server/services/config-utils` 的 `configError`/`configSuccess`——两者的信封形状一致
 * （`{ success, data }` / `{ success: false, error: { code, message } }`），是 `/web` 的既有约定而非宿主私有
 * 逻辑，包内保留一份即可（少一个跨包耦合点，不会形成第二套语义）。
 */
export function createWebAgentGenerationRoutes(deps: WebAgentConfigRouteDependencies) {
  const app = new Elysia({ name: "web-agent-generation" }).use(deps.authGuardPlugin).model({
    "generation-body": GenerationBodySchema,
  });

  app.post(
    "/agent-generation",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store, body, error }: any) => {
      if (!isGenerationConfigured()) {
        return error(503, buildWebErrorBody("NOT_CONFIGURED", "Agent generation model is not configured"));
      }

      try {
        // 生成过程要按主体可见性挑选候选技能，因此传可信主体而不是宿主认证上下文。
        const result = await generateAgentConfig(store.actor as ActorContext, body.prompt as string);
        return { success: true as const, data: result };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        if (errMsg === "NOT_CONFIGURED") {
          return error(503, buildWebErrorBody("NOT_CONFIGURED", "Agent generation model is not configured"));
        }
        if (errMsg === "PARSE_ERROR") {
          return error(422, buildWebErrorBody("PARSE_ERROR", "Failed to parse AI response"));
        }

        // OpenAI SDK 错误：区分错误码，暴露可诊断的错误信息
        const openaiMatch = errMsg.match(/^OPENAI_(AUTH_ERROR|RATE_LIMIT|CONNECTION_ERROR|API_ERROR): (.+)/);
        if (openaiMatch) {
          const [, errorType, detail] = openaiMatch;
          const statusMap: Record<string, number> = {
            AUTH_ERROR: 502,
            RATE_LIMIT: 429,
            CONNECTION_ERROR: 502,
            API_ERROR: 502,
          };
          console.error(`[agent-generation] OpenAI ${errorType}:`, detail);
          return error(statusMap[errorType] ?? 500, buildWebErrorBody(errorType, detail));
        }

        console.error("[agent-generation] LLM call failed:", err);
        return error(500, buildWebErrorBody("LLM_ERROR", `Failed to generate agent configuration: ${errMsg}`));
      }
    },
    {
      sessionAuth: true,
      body: "generation-body",
      response: {
        200: AgentGenerationResponseSchema,
        422: WebErrSchema,
        500: WebErrSchema,
        503: WebErrSchema,
      },
      detail: { tags: ["AgentConfig"], summary: "Agent 智能生成" },
    },
  );

  return app;
}
