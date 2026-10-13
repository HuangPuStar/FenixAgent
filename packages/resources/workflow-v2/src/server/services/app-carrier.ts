/**
 * 租户 App 的**上游载体协议**：端点、请求体、响应读取与「目标不存在」判定。
 *
 * 为什么存在两种载体（2026-10-09 实测，背景见 `docs/design/2026-10-09-workflow-v2-api-channel-release.md`）：
 * 上游把「workflow 属主」与「可发布到渠道的载体」统一在**应用（Project）实体**上——workflow 的 `project_id`
 * 指向应用，「把应用发布到 API 渠道」是 `connector_workflow_version` 唯一的写入路径，即对外触发接口能跑起来
 * 的前提。bot 载体没有这条链路（`ReleaseApplicationWorkflows` 只按应用取 workflow；bot 发布实测不写登记表）。
 * 因此**新绑定一律建应用**；只有上游构建没有应用接口（HTTP 404）时才退回 bot，让绑定与控制台照常可用。
 * 移除条件：固定镜像的上游构建确定提供应用接口后，删除 {@link LEGACY_BOT_CARRIER} 及其分支。
 *
 * 本文件只回答「用哪个端点、字段叫什么、什么算不存在」，绑定生命周期（单飞、落库、降级）留在
 * `org-app-binding.ts`。
 */

/** 建租户 App 的端点（运维面动作）。 */
const CREATE_APP_PATH = "/api/intelligence_api/draft_project/create";

/** 按 id 查应用（`intelligence_type=2` = Project）；无此 id 时回业务码 `101000002`。 */
const GET_APP_INFO_PATH = "/api/intelligence_api/search/get_draft_intelligence_info";

/** 删除应用：只用于并发收敛后清理孤儿，不参与绑定生命周期。 */
const DELETE_APP_PATH = "/api/intelligence_api/draft_project/delete";

/** 旧载体（bot）端点：仅当上游构建没有应用接口（HTTP 404）时兜底。 */
const LEGACY_CREATE_APP_PATH = "/api/draftbot/create";
const LEGACY_GET_APP_INFO_PATH = "/api/playground_api/draftbot/get_draft_bot_info";
const LEGACY_DELETE_APP_PATH = "/api/draftbot/delete";

/** App 存活探测的三种结果：「在」「上游明确说不存在」「未确认」（不可达/被拒/形状不认识）。 */
export type AppExistence =
  | { readonly kind: "ok"; readonly name: string | null }
  | { readonly kind: "missing" }
  | { readonly kind: "unreachable" };

/** 载体标识；只用于日志与错误文案区分，不参与判定。 */
export type AppCarrierLabel = "app" | "bot";

/**
 * 载体适配器：应用与 bot 只在端点、id 字段与「不存在」码上不同，建/查/删三条语义完全一致。
 */
export interface AppCarrier {
  readonly label: AppCarrierLabel;
  readonly createPath: string;
  readonly infoPath: string;
  readonly deletePath: string;
  /** 探测请求体：应用按 `intelligence_id` + 类型，bot 按 `bot_id`。 */
  readonly infoBody: (appId: string) => Record<string, unknown>;
  /** 删除请求体：应用只认 `project_id`，bot 还要 `space_id`。 */
  readonly deleteBody: (appId: string, spaceId: string) => Record<string, unknown>;
  readonly readCreatedId: (body: unknown) => string | null;
  readonly readName: (body: unknown) => string | null;
  /** 该载体「目标不存在」的业务码。 */
  readonly notFoundCode: number;
  /** 该载体的探测接口本身可能不存在（旧构建）：HTTP 404 也算「这个 id 不在」。 */
  readonly missingEndpointMeansAbsent: boolean;
}

/** 应用实体的「目标不存在」业务码（上游 `errno.ErrAppRecordNotFound`）：不存在的 `project_id` → `101000002`。 */
export const APP_NOT_FOUND_CODE = 101000002;

/** bot 载体的「目标不存在」业务码：不存在的 `bot_id` → `100000000 invalid parameter : agent <id> not found`。 */
export const UPSTREAM_APP_NOT_FOUND_CODE = 100000000;

/** 当前唯一正确的载体：上游应用（Project）。 */
export const APP_CARRIER: AppCarrier = {
  label: "app",
  createPath: CREATE_APP_PATH,
  infoPath: GET_APP_INFO_PATH,
  deletePath: DELETE_APP_PATH,
  infoBody: (appId) => ({ intelligence_id: appId, intelligence_type: 2 }),
  deleteBody: (appId) => ({ project_id: appId }),
  readCreatedId: readAppId,
  readName: readAppName,
  notFoundCode: APP_NOT_FOUND_CODE,
  missingEndpointMeansAbsent: true,
};

/** 旧载体（bot）：只在应用接口不可用时兜底，见文件头。 */
export const LEGACY_BOT_CARRIER: AppCarrier = {
  label: "bot",
  createPath: LEGACY_CREATE_APP_PATH,
  infoPath: LEGACY_GET_APP_INFO_PATH,
  deletePath: LEGACY_DELETE_APP_PATH,
  infoBody: (appId) => ({ bot_id: appId }),
  deleteBody: (appId, spaceId) => ({ space_id: spaceId, bot_id: appId }),
  readCreatedId: readBotId,
  readName: readBotName,
  notFoundCode: UPSTREAM_APP_NOT_FOUND_CODE,
  missingEndpointMeansAbsent: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读嵌套字段（缺失或形状不符时为 null）。 */
function readPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current;
}

/** 统一的 id 读取：字符串或有限数字都接受，其余为 null（上游 JSON 里 id 有时是数字形态）。 */
function readIdValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** 读应用详情里的展示名（`data.basic_info.name`）；缺失时为 null（调用方回退到既有名字）。 */
function readAppName(body: unknown): string | null {
  const name = readPath(body, ["data", "basic_info", "name"]);
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** 读创建应用响应里的 `data.project_id`。 */
function readAppId(body: unknown): string | null {
  return readIdValue(readPath(body, ["data", "project_id"]));
}

/** 读 bot 详情里的展示名（`data.bot_info.name`）；缺失时为 null。 */
function readBotName(body: unknown): string | null {
  const name = readPath(body, ["data", "bot_info", "name"]);
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** 读创建 bot 响应里的 `data.bot_id`。 */
function readBotId(body: unknown): string | null {
  return readIdValue(readPath(body, ["data", "bot_id"]));
}
