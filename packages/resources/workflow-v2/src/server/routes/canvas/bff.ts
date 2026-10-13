import { Elysia } from "elysia";
import {
  CANVAS_TICKET_HEADER,
  type CanvasBffResult,
  handleCanvasPassthrough,
  handleSessionExchange,
  handleSessionRefresh,
  handleSessionRevoke,
} from "../../services/canvas-passthrough";

/**
 * `/workflow-canvas/bff/*` — 画布透传面（设计 §4.4，冻结 §6/§7）。
 *
 * 本文件只做协议适配：从请求上取出票据头、查询串、请求体与来源地址，交给
 * `services/canvas-passthrough.ts`，再把 `{status, body}` 原样交给 HTTP 层。**所有判定（白名单、票据、
 * 归属、注入、脱敏）都在服务层**，路由不复制第二份口径——两条面各自维护白名单必然漂移。
 *
 * 因此本面只有一条通配路由 + 三条 `session/*`：通配 handler 用完整请求路径作为上游路径（服务层按
 * `classifyUpstreamPath` 决定允许、拒绝或 404），`/api/workflow_api/*`、`/api/common/upload/*` 与
 * `/api/playground_api/get_imagex_url` 由同一条路径处理，不存在「加了白名单却忘了加路由」的缝。
 *
 * 响应形状是 **上游信封**（`{code,msg,data?}`），不是本平台的 `{success,data}`：画布 SDK 按前者解析，
 * 包装会打断它；失败分支同样用上游形状（票据失败还必须是真实 HTTP 401，见服务层注释）。
 *
 * 限流（4B）在服务层判定，本层只把「等多久」落成 `Retry-After` 响应头（{@link respond}）：429 必须是真实
 * HTTP 429——画布只在 401 时换票，把限流做成 401 会让它去换一张同样被限的票，做成 200 又会被当成业务错误。
 *
 * 端点标记 `hide: true`：票据鉴权不是 OpenAPI 文档建模的会话认证，出现在控制台文档里只会误导调用方。
 *
 * 挂载形态：`app` 槽（不带会话守卫，冻结 §2.1），前缀写在实例上，声明序先于静态反代——`/workflow-canvas/*`
 * 是通配路由，挂载靠后才不会吞掉本面的请求。
 */

/** 实例前缀；上游路径＝请求路径去掉该前缀（服务层据此判定白名单）。 */
const BFF_PREFIX = "/workflow-canvas/bff";

/** 本面约定的请求体上限由服务层执行，这里只把 `Content-Length` 原文交给它。 */
function readContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 查询串 → 标量映射；重复键取最后一个值（上游的查询参数都是标量）。 */
function readQuery(request: Request): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) query[key] = value;
  return query;
}

/** 上游路径：请求路径去掉实例前缀（保留尾斜杠，让服务层按同一份口径判定）。 */
function readUpstreamPath(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.startsWith(BFF_PREFIX) ? pathname.slice(BFF_PREFIX.length) : pathname;
}

/**
 * 服务层结果 → HTTP：按状态与上游信封返回，并把限流给出的等待秒数落成 `Retry-After` 响应头。
 *
 * 「等多久」是服务层的事实（令牌桶算出来的），`Retry-After` 是它的传输层表达——只有 429 会带上它，
 * 其余状态即使误带了该字段也不写出（避免 200/401 上出现无意义的等待头）。
 */
function respond(
  result: CanvasBffResult,
  set: { headers: Record<string, string | number | undefined> },
  status: (code: number, body: unknown) => unknown,
): unknown {
  if (result.status === 429 && result.retryAfterSeconds !== undefined) {
    set.headers["retry-after"] = String(result.retryAfterSeconds);
  }
  return status(result.status, result.body);
}

/** 兑换限速的计数键：套接字对端地址（不可伪造）；拿不到时归入同一个兜底桶。 */
function readPeerKey(
  server: { requestIP?: (request: Request) => { address: string } | null } | null,
  request: Request,
): string {
  return server?.requestIP?.(request)?.address ?? "unknown";
}

export function createCanvasBffRoutes() {
  return (
    new Elysia({ name: "workflow-canvas-bff", prefix: BFF_PREFIX })
      .post(
        "/session/exchange",
        ({ request, body, status, server, set }) => {
          const result = handleSessionExchange({
            code: (body as { code?: unknown } | undefined)?.code,
            peerKey: readPeerKey(server, request),
          });
          return respond(result, set, status);
        },
        {
          detail: {
            hide: true,
            tags: ["Workflow V2"],
            summary: "兑换画布票据",
            description:
              "请求体 { code }；返回上游信封 { data: { ticket, expiresAt, claims }, code: 0, msg }。code 绑定 user + org + workflow，单次消费、" +
              "默认 60 秒有效；本端点免票，因此按来源地址令牌桶限流（阈值 WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE），超出返回真实 HTTP 429 + Retry-After。",
          },
        },
      )
      .post(
        "/session/refresh",
        ({ request, status, server, set }) => {
          const result = handleSessionRefresh({
            ticket: request.headers.get(CANVAS_TICKET_HEADER),
            peerKey: readPeerKey(server, request),
          });
          return respond(result, set, status);
        },
        {
          detail: {
            hide: true,
            tags: ["Workflow V2"],
            summary: "续期画布票据",
            description:
              "请求头 X-Fenix-Workflow-Ticket；返回新票据，过期时间取原 exp 与「现在 + 票据 TTL」的较小者（只能缩短，不能延长会话）；" +
              "票据无效返回真实 HTTP 401 + { code: 401, msg: ticket_invalid }，超限返回 429 + Retry-After。",
          },
        },
      )
      .post(
        "/session/revoke",
        ({ request, status, server, set }) => {
          const result = handleSessionRevoke({
            ticket: request.headers.get(CANVAS_TICKET_HEADER),
            peerKey: readPeerKey(server, request),
          });
          return respond(result, set, status);
        },
        {
          detail: {
            hide: true,
            tags: ["Workflow V2"],
            summary: "撤销画布票据",
            description:
              "请求头 X-Fenix-Workflow-Ticket；按票据的 sid 撤销整族票据（登出、切组织时由宿主调用），撤销后再出示同一票据返回 HTTP 401。",
          },
        },
      )
      // 通配 handler 覆盖白名单内的三条路径与其余路径的 404（判定都在服务层，见文件头）。
      .all(
        "/*",
        async ({ request, body, status, set }) => {
          const result = await handleCanvasPassthrough({
            method: request.method,
            path: readUpstreamPath(request),
            query: readQuery(request),
            ticket: request.headers.get(CANVAS_TICKET_HEADER),
            body,
            contentLength: readContentLength(request),
          });
          return respond(result, set, status);
        },
        {
          detail: {
            hide: true,
            tags: ["Workflow V2"],
            summary: "透传上游画布接口",
            description:
              "允许的前缀：/api/workflow_api/*、/api/common/upload/*、/api/playground_api/get_imagex_url，其余 404。流程：" +
              "ticket 鉴权（失败为真实 HTTP 401）→ 归属校验（显式 workflow 身份须与票据一致且本地注册表命中，否则 404）→ 注入" +
              " space_id/project_id（客户端同名字段与 bot_id 一律剥离）→ 上游调用 → 原样回传上游 { data, code, msg }（上游 panic 的" +
              " msg 脱敏，节点面板响应按白名单过滤）。",
          },
        },
      )
  );
}
