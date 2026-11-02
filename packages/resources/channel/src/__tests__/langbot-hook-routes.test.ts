import { afterEach, describe, expect, test } from "bun:test";
import { createLangBotHookRoutes } from "../server/routes/hooks/langbot";
import { installChannelModule } from "../server/runtime";
import { createDataPlaneTestContext, type DataPlaneTestContext, type DataPlaneTestInput } from "./data-plane-fixtures";
import { createChannelTestContext, makeChannel, makeRoute, resetChannelModule } from "./fixtures";

/**
 * `/hooks/langbot/:channelId` 的协议契约（规格 §4.3）。
 *
 * 这条路径没有会话认证，响应也不是 `/web` 的 `{ success, data }` 信封：LangBot 只认
 * `{ status, skip_pipeline }`。用例同时钉住状态码映射：未知通道 404、停用通道 200 并交回流水线。
 */

const CHANNEL_ID = "0f0e0d0c-0b0a-4a49-8b8a-090807060504";
const hookRoute = createLangBotHookRoutes();

function payloadFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: crypto.randomUUID(),
    event_type: "bot.person_message",
    data: {
      bot_uuid: "bot-1",
      sender: { id: "user-a", name: "Sender" },
      message: [{ type: "Plain", text: "你好" }],
      timestamp: 1_760_000_000,
    },
    ...overrides,
  };
}

function post(channelId: string, payload: unknown): Promise<Response> {
  return hookRoute.handle(
    new Request(`http://localhost/hooks/langbot/${channelId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
  );
}

const contexts: DataPlaneTestContext[] = [];

function installPlane(input: DataPlaneTestInput = {}): DataPlaneTestContext {
  const control = createChannelTestContext();
  const plane = createDataPlaneTestContext({
    channels: [makeChannel({ id: CHANNEL_ID })],
    routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a", agentConfigId: "agent-1" })],
    ...input,
  });
  installChannelModule({
    ...control.module,
    dataPlane: {
      conversationService: plane.conversationService,
      inbound: plane.inbound,
      outbound: plane.outbound,
      dispatcher: plane.dispatcher,
    },
  });
  contexts.push(plane);
  return plane;
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispatcher.stop();
  resetChannelModule();
});

describe("LangBot Webhook 路由", () => {
  // 接受与重复投递都必须让 LangBot 停止自己的流水线，响应体不能混入 /web 信封。
  test("接受与重复投递返回 skip_pipeline: true", async () => {
    const plane = installPlane();
    const payload = payloadFor();

    const accepted = await post(CHANNEL_ID, payload);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ status: "ok", skip_pipeline: true });

    const duplicate = await post(CHANNEL_ID, payload);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ status: "ok", skip_pipeline: true });

    expect(plane.events.rows).toHaveLength(1);
  });

  // 未知通道与非法 UUID 都不能通过状态码泄漏「哪些通道存在」；非法 JSON 属于调用方错误。
  test("未知通道与非法 UUID 返回 404，非法 JSON 返回 400", async () => {
    installPlane();

    expect((await post(crypto.randomUUID(), payloadFor())).status).toBe(404);
    expect((await post("not-a-uuid", payloadFor())).status).toBe(404);

    const invalid = await hookRoute.handle(
      new Request(`http://localhost/hooks/langbot/${CHANNEL_ID}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{not json",
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ status: "error" });
  });

  // 停用通道与无路由不接管消息：交回 LangBot 流水线，平台不做任何投递。
  test("停用通道与无路由返回 skip_pipeline: false", async () => {
    installPlane({ channels: [makeChannel({ id: CHANNEL_ID, enabled: false })] });
    const disabled = await post(CHANNEL_ID, payloadFor());
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ status: "ok", skip_pipeline: false });

    const unrouted = installPlane({ routes: [] });
    const noRoute = await post(CHANNEL_ID, payloadFor());
    expect(noRoute.status).toBe(200);
    expect(await noRoute.json()).toEqual({ status: "ok", skip_pipeline: false });
    expect(unrouted.events.rows[0]!.status).toBe("skipped");
  });

  // 非文本事件由平台发固定提示，因此必须接管；否则 LangBot 也会再回一遍，用户收到两条。
  test("非文本事件返回 skip_pipeline: true 并落 skipped", async () => {
    const plane = installPlane();

    const response = await post(
      CHANNEL_ID,
      payloadFor({ data: { bot_uuid: "bot-1", sender: { id: "user-a" }, message: [{ type: "Image", url: "x" }] } }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", skip_pipeline: true });
    expect(plane.events.rows[0]!.status).toBe("skipped");
  });
});
