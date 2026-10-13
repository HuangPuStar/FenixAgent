// pages/list/error-message.ts
// 失败提示的取值口径：`unwrap()` 抛出的 `ApiError.message` 就是服务端错误信封原文，优先上屏——把它换成
// 一句固定字典文案，用户与测试都定位不到后端故障。字典文案只在没有可读 message 时兜底。
//
// 文案收敛只允许发生在**稳定业务码**这类「下一步动作确定」的分支上（`initializeErrorKey` / `runErrorKey`
// 按码分流），其余失败一律取原文。

/** 取一句可上屏的服务端失败原因；非 Error 抛出或 message 为空时返回 null，由调用方回落到字典文案。 */
export function errorMessage(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}
