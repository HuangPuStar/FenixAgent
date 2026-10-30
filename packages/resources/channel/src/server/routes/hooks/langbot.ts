import { error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { getChannelModule } from "../../runtime";

/**
 * LangBot Webhook 入站端点（规格 §4.3 / §11.10）。
 *
 * `POST /hooks/langbot/:channelId`——无会话认证：`channelId` 是 UUID v4 路径凭据，LangBot 只把它当作
 * 不可枚举的回调地址。响应不是 `/web` 的 `{ success, data }`，而是 LangBot 约定的
 * `{ status, skip_pipeline }`：
 * - 接受并接管：`skip_pipeline: true`，LangBot 不再跑自己的流水线；
 * - 停用通道 / Bot 不匹配 / 未 @ 机器人 / 无路由：`skip_pipeline: false`，交回 LangBot 兜底；
 * - 未知通道 404。
 *
 * 端点只做协议映射，解析、去重、路由与会话在 `inbound-service`。体积限制是 **best-effort**：处理器内只
 * 按 `content-length` 尽力拦截带声明长度的超大请求；chunked 请求不带该头，由实例级 `maxRequestBodySize`
 * 上限兜底（Elysia 1.4 没有路由级上限）。
 */

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return;
  }
}

export function createLangBotHookRoutes() {
  return new Elysia({ name: "hooks-langbot" })
    .onError(({ code, error, status }) => {
      if (code === "VALIDATION") return status(400, { status: "error" });
      if (code === "NOT_FOUND") return;
      logError("LangBot Webhook 处理失败", error instanceof Error ? error : undefined);
      return status(500, { status: "error" });
    })
    .post(
      "/hooks/langbot/:channelId",
      async ({ params, body, request, status }) => {
        const declared = request.headers.get("content-length");
        if (declared !== null && Number(declared) > MAX_WEBHOOK_BYTES) {
          return status(413, { status: "error" });
        }

        const channelId = params.channelId;
        if (!UUID_PATTERN.test(channelId)) return status(404, { status: "error" });

        const payload = parseBody(body);
        if (payload === undefined) return status(400, { status: "error" });

        const inbound = getChannelModule().dataPlane?.inbound;
        if (!inbound) throw new Error("Channel 数据面未装配：Webhook 无法处理入站事件");

        const outcome = await inbound.handle({ channelId, payload });
        switch (outcome.kind) {
          case "rejected":
            if (outcome.reason === "channel_missing") return status(404, { status: "error" });
            if (outcome.reason === "invalid_payload") return status(400, { status: "error" });
            return { status: "ok", skip_pipeline: false };
          case "duplicate":
            return { status: "ok", skip_pipeline: true };
          case "accepted":
            return { status: "ok", skip_pipeline: true };
          case "skipped":
            // 无路由交回 LangBot 流水线；非文本已由平台发固定提示，因此由平台接管。
            return { status: "ok", skip_pipeline: outcome.reason === "non_text" };
        }
      },
      {
        detail: {
          hide: true,
          tags: ["Channel"],
          summary: "LangBot IM 事件 Webhook",
          description:
            "LangBot 收到 IM 消息后调用。接受的事件返回 skip_pipeline: true，由平台 Agent 处理；未知通道 404。",
        },
      },
    );
}
