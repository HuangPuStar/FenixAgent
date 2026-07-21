import Elysia from "elysia";
import { z } from "zod/v4";
import { authGuardPlugin } from "../../plugins/auth";
import { AgentGenerationResponseSchema } from "../../schemas/agent-generation.schema";
import { WebErrSchema } from "../../schemas/common.schema";
import { generateAgentConfig, isGenerationConfigured } from "../../services/agent-generation";
import { configError, configSuccess } from "../../services/config-utils";

const GenerationBodySchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
});

const app = new Elysia({ name: "web-agent-generation" }).use(authGuardPlugin).model({
  "generation-body": GenerationBodySchema,
});

app.post(
  "/agent-generation",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;

    if (!isGenerationConfigured()) {
      return error(503, configError("NOT_CONFIGURED", "Agent generation model is not configured"));
    }

    try {
      const result = await generateAgentConfig(authCtx, body.prompt as string);
      return configSuccess(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (errMsg === "NOT_CONFIGURED") {
        return error(503, configError("NOT_CONFIGURED", "Agent generation model is not configured"));
      }
      if (errMsg === "PARSE_ERROR") {
        return error(422, configError("PARSE_ERROR", "Failed to parse AI response"));
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
        return error(statusMap[errorType] ?? 500, configError(errorType, detail));
      }

      console.error("[agent-generation] LLM call failed:", err);
      return error(500, configError("LLM_ERROR", `Failed to generate agent configuration: ${errMsg}`));
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

export default app;
