// web/lib/error-message.ts
// 失败提示的取值口径：`unwrap()` 抛出的 `ApiError.message` 就是服务端错误信封原文，优先上屏——把它换成
// 一句固定字典文案，用户与测试都定位不到后端故障（2026-10-12 的「错误文案收口」因此回滚）。字典文案只在
// 没有可读 message 时兜底。
//
// 与 workflow-v2 的 `pages/list/error-message.ts` 同形不同源：本包不跨包依赖别包的页面级私有文件。

/**
 * 取一句可上屏的服务端失败原因。
 *
 * `null` 表示取不到：抛出的是非 Error 值，或 message 为空——此时由调用方回落本包字典文案。
 */
export function errorMessage(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}
