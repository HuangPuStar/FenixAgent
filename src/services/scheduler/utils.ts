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
