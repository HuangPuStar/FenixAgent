// pages/canvas/canvas-protocol.ts
// 画布宿主页的**线协议**（纯函数：无 React、无网络）：父子 postMessage 信封与 iframe URL。
//
// 契约来源：接口冻结 §7（消息类型集合与 `bind`/`token` 载荷）与设计 §5.2（iframe URL 参数与映射责任方）。
// 与画布侧 `bot-http/src/host-bridge.ts` 逐字对齐的三条硬约束：
// 1. 信封 `{ v: 1, id, type, ts, payload }`；`v` 不为 1 的消息整条丢弃（协议演进用）；
// 2. 父→子**固定 `targetOrigin` 为控制台自身 origin，绝不用 `"*"`**（发送在 `use-canvas-handshake` 里，
//    因为那需要窗口引用）；
// 3. 子→父同时校验 `event.origin` 与 `event.source === iframe.contentWindow`（同上，需要 DOM 引用）。
//
// iframe URL 参数直接用上游画布认识的名字（`workflow_id` / `space_id` / `apiBase` / `lng` / `theme`）：
// 映射责任方在宿主页，画布侧不做二次翻译（设计 §5.2 与 1F 实测 §1.3 都明确否定 `wf`/`view`/`locale` 一套）。

import { CANVAS_API_BASE } from "../../api/canvas-session";

/** 信封版本号；与画布侧 `ENVELOPE_VERSION` 必须一致，不一致的消息直接忽略。 */
export const CANVAS_ENVELOPE_VERSION = 1;

/** 画布 SPA 的画布入口路径（同源反代前缀 `/workflow-canvas/*` 下）。 */
export const CANVAS_FRAME_PATH = "/workflow-canvas/work_flow";

/**
 * 画布主题。
 *
 * 常量而不是变量：本仓控制台全局强制亮色（前端规范 §3.2，`theme` 键已不再被读写），画布必须与宿主一致，
 * 否则深浅混排。将来控制台支持切换时，这里改成读取宿主主题即可，协议与参数名不变。
 */
export const CANVAS_FRAME_THEME = "light";

/** 画布支持的界面语言（i18n 检测器读的 `lng` 参数取值，设计 §5.2）。 */
export type CanvasFrameLanguage = "zh-CN" | "en";

/** 画布 → 宿主 的消息类型（本页消费 `ready|refresh-request|error|navigate-out`；`bound`/`resize` 见下方注释）。 */
export type CanvasToHostMessageType = "ready" | "bound" | "refresh-request" | "error" | "resize" | "navigate-out";

/** 宿主 → 画布 的消息类型。 */
export type HostToCanvasMessageType = "bind" | "token" | "signout" | "theme" | "locale";

/** 信封（冻结 §7）；`v` 是字面量类型，构造时写入当前版本。 */
export interface CanvasMessageEnvelope<TType extends string, TPayload> {
  readonly v: typeof CANVAS_ENVELOPE_VERSION;
  /** 诊断用消息 id，不参与鉴权。 */
  readonly id: string;
  readonly type: TType;
  readonly ts: number;
  readonly payload: TPayload;
}

/** 文档内自增序号，与时间戳拼成诊断用 id（不参与鉴权，无需全局唯一；与画布侧同款）。 */
let messageSeq = 0;

/** 构造宿主 → 画布 的信封。 */
export function createHostMessage<TType extends HostToCanvasMessageType, TPayload>(
  type: TType,
  payload: TPayload,
): CanvasMessageEnvelope<TType, TPayload> {
  messageSeq += 1;
  return { v: CANVAS_ENVELOPE_VERSION, id: `${Date.now()}-${messageSeq}`, type, ts: Date.now(), payload };
}

/**
 * 解析画布 → 宿主 的信封；形状不认识（非对象、版本不符、`type` 非字符串或为空）时返回 null。
 *
 * 只做信封级校验，不限定 `type` 取值：未知类型由调用方忽略即可（画布侧对未列出的类型也是同样处理），
 * 在这里白名单化会让协议新增类型时必须同时改两侧。
 */
export function parseCanvasMessage(raw: unknown): { type: string; payload: unknown } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.v !== CANVAS_ENVELOPE_VERSION) return null;
  if (typeof record.type !== "string" || record.type.length === 0) return null;
  return { type: record.type, payload: record.payload };
}

/**
 * `error` 消息里的 `retryable`（冻结 §7 的载荷字段）：只有显式为 `true` 才给重试入口。
 *
 * 画布上报的 `code` / `message` **不上屏**：`message` 是对方进程的诊断串，界面一律按稳定 error code 取
 * 字典文案（前端规范 §9.3「不展示 raw message」）。
 */
export function readCanvasErrorRetryable(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as Record<string, unknown>).retryable === true;
}

/** iframe URL 的构造入参。 */
export interface CanvasFrameParams {
  /** 上游 workflow ID（= 票据 `claims.wf` = 透传请求的 `workflow_id`）。 */
  readonly upstreamWorkflowId: string;
  /** 平台个人空间 ID（来自平台账号台账，不是 workflow 记录里的字段）。 */
  readonly platformSpaceId: string;
  readonly language: CanvasFrameLanguage;
}

/**
 * 拼画布 iframe 的 URL。
 *
 * 只拼非空参数：`space_id` 缺失时**不产出空值参数**（`?space_id=` 会让画布读到空串并当作有效空间），
 * 调用方在拿到空间 ID 之前根本不该进入 this 分支——上游未就绪的判定见 `canvas-hosting-model.ts`。
 */
export function buildCanvasFrameUrl(params: CanvasFrameParams): string {
  const search = new URLSearchParams({
    workflow_id: params.upstreamWorkflowId,
    space_id: params.platformSpaceId,
    apiBase: CANVAS_API_BASE,
    lng: params.language,
    theme: CANVAS_FRAME_THEME,
  });
  return `${CANVAS_FRAME_PATH}?${search.toString()}`;
}

/** i18n 当前语言 → 画布 `lng` 参数：只有 en 系语言走英文，其余（含未识别）一律中文。 */
export function toCanvasLanguage(language: string | undefined): CanvasFrameLanguage {
  return language?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}
