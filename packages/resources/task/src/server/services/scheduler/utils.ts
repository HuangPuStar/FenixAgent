/** 将 node-schedule invocation 对象转换为 Date（兼容多种运行时） */
export function toInvocationDate(invocation: unknown): Date | null {
  if (!invocation) return null;
  if (invocation instanceof Date) return invocation;
  if (typeof invocation === "object" && invocation !== null) {
    if ("toDate" in invocation && typeof invocation.toDate === "function") {
      return (invocation as { toDate: () => Date }).toDate();
    }
    if ("toJSDate" in invocation && typeof invocation.toJSDate === "function") {
      return (invocation as { toJSDate: () => Date }).toJSDate();
    }
  }
  return null;
}

/**
 * 判断 HTTP 执行器抛出的异常是否属于「超时」。
 *
 * 为什么按 `instanceof Error` + `name` 而不是字符串匹配消息：`AbortSignal.timeout` 在 Bun 与 Node.js
 * 抛出的分别是 DOMException 与 Error，但 name 都是 `TimeoutError` / `AbortError`，消息文本则随运行时与
 * 版本变化，按消息匹配会在运行时升级后静默把超时归类成 failed。
 *
 * 为什么导出：分类结果决定执行日志的 `status`（超时与失败对应不同的运维处置），原先把判定内联在 catch 里，
 * 用例只能复制一份同样的条件——复制件与实现漂移时用例照样全绿。这里导出真实判定，用例直接断言它。
 */
export function isTimeoutAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
