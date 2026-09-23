import { AppError } from "@fenix/platform-sdk";

/**
 * 插件市场的封闭错误码清单。
 *
 * 为什么需要一份封闭清单而不是随手 `new Error("...")`：市场的失败原因**要跨协议边界回给浏览器**，而前端
 * 按码分支（`PREVIEW_CHANGED` 要原地刷新预览、`PACKAGE_NOT_FOUND` 要提示包名写错、`REGISTRY_NOT_CONFIGURED`
 * 要提示部署未配置而非重试）。随手写的字符串一旦漂移，前端会静默落进兜底分支，把「部署未配置」显示成
 * 「网络错误」并引导用户反复重试。
 *
 * 清单只收**本模块真的会抛**的码。相对源项目（`packages/mcp-market/src/errors.ts`）删掉四个：
 * - `UNAUTHENTICATED` / `FORBIDDEN_ORIGIN`：源项目自建的单账户登录与 Origin 守卫，本仓库由 better-auth 与
 *   宿主认证插件承担，市场不参与认证决策。
 * - `HTTP_SOURCE_UNAVAILABLE`：第二来源（MCP over HTTP 发现客户端）不在本期范围。
 * - `INTERNAL_ERROR`：源项目自带 HTTP 框架与 `fail()` 映射器，需要一个兜底码；本仓库的未知异常由宿主
 *   `apps/server/src/plugins/error-handler.ts` 统一落 500，本模块再造一个兜底码不会被任何人读到。
 *
 * 相对源项目另删一个码：**`CATALOG_CONFLICT` 在本仓库无产出点**。源项目用它表达「按版本读到的行与它
 * 的包行对不上」——那是 SQLite 里按 publication 出发读聚合才可能出现的孤儿行；本仓库的聚合读取从包行
 * 出发（`repositories/plugin-package.ts` 的 `loadCatalogState`），且写入路径全程持有事务级咨询锁
 * （`withPackageLock`），不存在「读到行、写入时行已被换掉」的窗口。留一个永不抛出的码只会让前端多一条
 * 永不执行的兜底分支。
 *
 * 新增码的前置条件：**必须同时有产出点与消费点**（某处抛它 + 前端或路由按它分支），否则它就是死枚举。
 */
export const PLUGIN_MARKET_ERROR_CODES = [
  "INVALID_INPUT",
  "PACKAGE_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "PUBLICATION_NOT_FOUND",
  "METADATA_INVALID",
  "METADATA_TOO_LARGE",
  "UNSUPPORTED_SCHEMA_VERSION",
  "PREVIEW_CHANGED",
  "REGISTRY_NOT_CONFIGURED",
  "REGISTRY_UNAVAILABLE",
  "REGISTRY_RATE_LIMITED",
] as const;

export type PluginMarketErrorCode = (typeof PLUGIN_MARKET_ERROR_CODES)[number];

/**
 * 错误码 → HTTP 状态。
 *
 * 与源项目逐条一致，只多一个 `REGISTRY_NOT_CONFIGURED`（源项目的源地址是必填配置，本仓库的
 * `PLUGIN_MARKET_REGISTRY_URL` 必须 optional —— 见 `fenix.module.ts` 的键说明）。它落 503 而不是 500：
 * 「部署没配私有源」是**服务当前不可用**，不是服务写错了；500 会让运维在错误日志里找不存在的缺陷。
 *
 * `MAP` 用 `Record<PluginMarketErrorCode, number>` 而非 `Partial<...>`：新增错误码忘了给状态会在
 * typecheck 期失败，不会退化成运行期的 undefined 状态码。
 */
const STATUS_BY_CODE: Record<PluginMarketErrorCode, number> = {
  INVALID_INPUT: 400,
  PACKAGE_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  PUBLICATION_NOT_FOUND: 404,
  METADATA_INVALID: 422,
  METADATA_TOO_LARGE: 413,
  UNSUPPORTED_SCHEMA_VERSION: 422,
  PREVIEW_CHANGED: 409,
  REGISTRY_NOT_CONFIGURED: 503,
  REGISTRY_UNAVAILABLE: 503,
  REGISTRY_RATE_LIMITED: 429,
};

/**
 * 市场的应用级错误：稳定错误码 + 默认 HTTP 状态 + 可选结构化细节。
 *
 * 继承平台契约包的 `AppError` 而不是自建 `Error` 子类：宿主全局错误处理器按 `instanceof AppError` 映射
 * 状态码（`packages/platform/platform-sdk/src/protocol/errors.ts` 的文件头解释了这条），自建类会让
 * 400/404/409 静默退化成 500。
 *
 * **`details` 的写入边界**：只允许放常量（如 `{ supported: 1 }`）与**已过白名单规范化并做过 secret 扫描**
 * 的快照（如 `PREVIEW_CHANGED` 回给前端的重读结果）。npm 私有源的原始响应、模块配置值、
 * `PLUGIN_MARKET_REGISTRY_TOKEN` 一律不得进入 details —— 它会经日志与错误响应离开进程。
 */
export class PluginMarketError extends AppError {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: PluginMarketErrorCode, message?: string, details: Record<string, unknown> = {}) {
    // `message` 缺省取错误码：AppError 的 message 是给人看的描述、不是契约，缺省值保持与码一致即可。
    super(message ?? code, code, STATUS_BY_CODE[code]);
    this.name = "PluginMarketError";
    this.details = details;
  }
}

/** 判断一个值是否是本模块的错误（路由本地捕获用；跨包判定仍以 `AppError` 为准）。 */
export function isPluginMarketError(value: unknown): value is PluginMarketError {
  return value instanceof PluginMarketError;
}
