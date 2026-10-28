import { error as logError } from "@fenix/logger";
import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { ChannelControlError } from "../../contracts";
import { getChannelModule } from "../../runtime";
import {
  type BotCreateBody,
  BotCreateBodySchema,
  BotListViewResponseSchema,
  type BotUpdateBody,
  BotUpdateBodySchema,
  BotUuidParamsSchema,
  BotViewResponseSchema,
  ConversationListQuerySchema,
  ConversationPageResponseSchema,
  LangBotStatusResponseSchema,
  OkResponseSchema,
  type RouteCreateBody,
  RouteCreateBodySchema,
  RouteIdParamsSchema,
  RouteListQuerySchema,
  RouteListViewResponseSchema,
  type RouteUpdateBody,
  RouteUpdateBodySchema,
  RouteViewResponseSchema,
  TestSendBodySchema,
} from "../../schemas/langbot.schema";
import type { ChannelWebRouteDependencies } from "../dependencies";

/**
 * `/web/channels/langbot` 控制面协议层。
 *
 * 只做协议接入：请求校验、主体提取、响应信封。授权、租户边界、LangBot 调用与补偿全部在 Facade 内完成。
 *
 * 状态码口径：领域错误自带 `status`（跨组织 404、路由冲突 409、上游拒绝 502、未配置 503），这里不维护
 * 第二张映射表，避免两处各改一半。未识别的异常统一 500 + `INTERNAL_ERROR`，原始错误只进日志。
 */

// biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下无法稳定推断 handler context
type RouteContext = any;

/** `/web` 协议可能出现的错误状态；全部声明以便 OpenAPI 完整。 */
const errorResponses = {
  400: WebErrSchema,
  401: WebErrSchema,
  403: WebErrSchema,
  404: WebErrSchema,
  409: WebErrSchema,
  500: WebErrSchema,
  502: WebErrSchema,
  503: WebErrSchema,
} as const;

function errorBody(code: string, message: string) {
  return { success: false as const, error: { code, message } };
}

function requireActor(context: RouteContext): ActorContext {
  const actor = context.store.actor as ActorContext | null;
  if (!actor) throw new ChannelControlError("UNAUTHORIZED", 401, "请求缺少组织上下文");
  return actor;
}

/** 执行 handler 并包成 `/web` 成功信封。 */
async function run<T>(context: RouteContext, handler: (actor: ActorContext) => Promise<T>) {
  const actor = requireActor(context);
  return { success: true as const, data: await handler(actor) };
}

/** 需要 201 的创建端点：领域层给出成功状态码，协议层只负责把它落到响应上。 */
async function runCreated<T>(
  context: RouteContext,
  handler: (actor: ActorContext) => Promise<{ status: number; data: T }>,
) {
  const actor = requireActor(context);
  const result = await handler(actor);
  const body = { success: true as const, data: result.data };
  return result.status === 200 ? body : context.status(result.status, body);
}

export function createLangBotWebRoutes(deps: ChannelWebRouteDependencies) {
  const app = new Elysia({ name: "web-channels-langbot", prefix: "/channels/langbot" })
    .use(deps.authGuardPlugin)
    .onError(({ code, error, status }) => {
      // 先认本包的结构化错误：它的 `code` 字段会被 Elysia 误当作内建错误类型，若先判 `code` 分支会被
      // 默认处理器接管并返回纯文本。
      if (error instanceof ChannelControlError) return status(error.status, errorBody(error.code, error.message));
      if (code === "VALIDATION") return status(400, errorBody("INVALID_INPUT", "请求参数不合法"));
      // 未匹配路由交给 Elysia 的默认 404，不要把它包装成 500。
      if (code === "NOT_FOUND") return;
      logError("LangBot 控制面请求失败", error instanceof Error ? error : undefined);
      return status(500, errorBody("INTERNAL_ERROR", "通道控制面内部错误"));
    });

  app.get(
    "/status",
    (context: RouteContext) => run(context, async (actor) => (await getChannelModule().facade.status(actor)).data),
    {
      sessionAuth: true,
      response: { 200: LangBotStatusResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "探测 LangBot 服务",
        description:
          "请求 LangBot 的 /healthz 与 /api/v1/system/info，返回可达性、版本、发行版与初始化向导状态。未配置 LANGBOT_BASE_URL / LANGBOT_API_KEY 时返回 503。",
      },
    },
  );

  app.get("/bots", (context: RouteContext) => run(context, (actor) => getChannelModule().facade.listBots(actor)), {
    sessionAuth: true,
    response: { 200: BotListViewResponseSchema, ...errorResponses },
    detail: {
      tags: ["Channel"],
      summary: "列出 LangBot Bot 与平台通道的并集",
      description:
        "LangBot 侧 Bot 与平台 im_channel 记录的并集；只有平台记录的漂移行会标记 missingInLangbot。不返回 Bot config。",
    },
  });

  app.post(
    "/bots",
    (context: RouteContext) =>
      runCreated(context, (actor) => getChannelModule().facade.createBot(actor, context.body as BotCreateBody)),
    {
      sessionAuth: true,
      body: BotCreateBodySchema,
      response: { 201: BotViewResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "创建 Bot 与平台通道",
        description:
          "先调用 LangBot 创建 Bot，成功后再写入 im_channel；本地写入失败会补偿删除远端 Bot。config 只透传，不落库、不回显。",
      },
    },
  );

  app.get(
    "/bots/:botUuid",
    (context: RouteContext) =>
      run(context, (actor) => getChannelModule().facade.getBot(actor, (context.params as { botUuid: string }).botUuid)),
    {
      sessionAuth: true,
      params: BotUuidParamsSchema,
      response: { 200: BotViewResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "读取单个 Bot 与平台通道",
        description: "LangBot 中已不存在的 Bot 仍会返回平台记录，并标记 missingInLangbot。",
      },
    },
  );

  app.patch(
    "/bots/:botUuid",
    (context: RouteContext) =>
      run(context, (actor) =>
        getChannelModule().facade.updateBot(
          actor,
          (context.params as { botUuid: string }).botUuid,
          context.body as BotUpdateBody,
        ),
      ),
    {
      sessionAuth: true,
      params: BotUuidParamsSchema,
      body: BotUpdateBodySchema,
      response: { 200: BotViewResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "更新 Bot 名称、适配器或配置",
        description:
          "只转发 LangBot 支持的字段（上游为 PUT）。未提供 config 时保持 LangBot 上的原配置，不会被空对象覆盖。",
      },
    },
  );

  app.delete(
    "/bots/:botUuid",
    (context: RouteContext) =>
      run(context, async (actor) => {
        await getChannelModule().facade.deleteBot(actor, (context.params as { botUuid: string }).botUuid);
        return { ok: true };
      }),
    {
      sessionAuth: true,
      params: BotUuidParamsSchema,
      response: { 200: OkResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "删除 Bot 与平台通道",
        description:
          "先删除 LangBot Bot（远端 404 视为已删除），再删除平台通道并由外键级联清理路由与会话。远端删除失败时保留通道与全部关联，并标记 disabled / lastError 以便人工重试。",
      },
    },
  );

  app.post(
    "/bots/:botUuid/send",
    (context: RouteContext) =>
      run(context, async (actor) => {
        const body = context.body as {
          targetType: "person" | "group";
          targetId: string;
          text: string;
        };
        await getChannelModule().facade.testSend(actor, (context.params as { botUuid: string }).botUuid, body);
        return { ok: true };
      }),
    {
      sessionAuth: true,
      params: BotUuidParamsSchema,
      body: TestSendBodySchema,
      response: { 200: OkResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "通过 Bot 测试发送消息",
        description: "调用 LangBot send_message 发送一条纯文本；发送结果会更新通道的 status 与 lastError。",
      },
    },
  );

  app.get(
    "/routes",
    (context: RouteContext) =>
      run(context, (actor) =>
        getChannelModule().facade.listRoutes(actor, {
          channelId: (context.query as { channelId?: string }).channelId,
        }),
      ),
    {
      sessionAuth: true,
      query: RouteListQuerySchema,
      response: { 200: RouteListViewResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "列出通道路由",
        description: "按 channelId 过滤；不传时返回当前组织全部通道的路由。",
      },
    },
  );

  app.post(
    "/routes",
    (context: RouteContext) =>
      runCreated(context, (actor) => getChannelModule().facade.createRoute(actor, context.body as RouteCreateBody)),
    {
      sessionAuth: true,
      body: RouteCreateBodySchema,
      response: { 201: RouteViewResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "创建通道路由",
        description:
          "同一通道 + 聊天类型下，精确路由与通配路由各最多一条。agentConfigId 必须对通道所有者可见且可 use。",
      },
    },
  );

  app.patch(
    "/routes/:id",
    (context: RouteContext) =>
      run(context, (actor) =>
        getChannelModule().facade.updateRoute(
          actor,
          (context.params as { id: string }).id,
          context.body as RouteUpdateBody,
        ),
      ),
    {
      sessionAuth: true,
      params: RouteIdParamsSchema,
      body: RouteUpdateBodySchema,
      response: { 200: RouteViewResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "更新通道路由",
        description: "可更新 chatType、chatId、agentConfigId 与 enabled；chatId 传 null 表示改为通配路由。",
      },
    },
  );

  app.delete(
    "/routes/:id",
    (context: RouteContext) =>
      run(context, async (actor) => {
        await getChannelModule().facade.deleteRoute(actor, (context.params as { id: string }).id);
        return { ok: true };
      }),
    {
      sessionAuth: true,
      params: RouteIdParamsSchema,
      response: { 200: OkResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "删除通道路由",
        description: "删除后该聊天的下一次入站消息将重新匹配路由。",
      },
    },
  );

  app.get(
    "/conversations",
    (context: RouteContext) =>
      run(context, (actor) => {
        const query = context.query as { channelId?: string; page: number; pageSize: number };
        return getChannelModule().facade.listConversations(actor, query);
      }),
    {
      sessionAuth: true,
      query: ConversationListQuerySchema,
      response: { 200: ConversationPageResponseSchema, ...errorResponses },
      detail: {
        tags: ["Channel"],
        summary: "列出 IM 会话映射",
        description:
          "只读：返回 sessionId 脱敏后的会话键、agentConfigId 与最近事件/回复时间，不返回聊天正文与 ACP session。",
      },
    },
  );

  return app;
}
