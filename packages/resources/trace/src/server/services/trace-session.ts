import { docManager, getSessionRoot } from "@fenix/chat-channel/server";

/**
 * 由平台会话定位 Langfuse 会话。
 *
 * **映射关系（唯一真相）**：peri 上报观测时把 Langfuse `session_id` 写成 ACP `sessionId`
 * （peri-controller 的 `LangfuseTracer`，注释原文「Langfuse session_id = 会话的 thread_id」），而该 id 就是
 * `session/new` 返回、平台记在 Session Doc 里的 `session.sessionId`。因此「按会话列 run」不需要平台侧维护
 * 一张额外的映射表，读 Doc 投影即可得到分组键。
 *
 * 为什么只认**当前活跃**会话：面板跟随用户正在看的这轮对话（`replaceProjection` 换代后 Doc 里的
 * `session.sessionId` 同步变化），这也让「查谁的数据」由 Doc 事实决定而不是由浏览器传参决定——浏览器传的
 * sessionId（URL 里的实例 uid）只用来算 rcsSessionId，永远不直接充当 Langfuse 过滤条件。
 */
export interface TraceSessionLookup {
  /** 解析该 rcsSessionId 当前的活跃 ACP session id；Doc 不存在或尚未 `session/new` 时返回 null。 */
  readonly resolveActiveAcpSessionId: (rcsSessionId: string) => string | null;
}

/**
 * 嵌套共享容器的**结构**读取口：Y.Map 有 `get`，但其类型不在本包的依赖契约里。
 *
 * 刻意不 `import type * as Y from "yjs"`：`getSessionRoot` 的返回类型已由 chat-channel 声明，本包并不直接
 * 调用 yjs 的 API，为「对端签名里出现的类型」补一条依赖会把 yjs 写进本包 manifest。同一原因也不能用
 * `instanceof Map` 判型——`Y.Map` 不是内建 `Map` 的子类（恒假，会把读取静默变成永远 null）。
 */
type NestedReader = { get(key: string): unknown };

function isNestedReader(value: unknown): value is NestedReader {
  return typeof value === "object" && value !== null && typeof (value as NestedReader).get === "function";
}

function readNestedString(container: unknown, key: string): string | null {
  if (!isNestedReader(container)) return null;
  const value = container.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 从 Session Doc 读取活跃 ACP session id（缺失一律返回 null，不做前缀改写或兜底猜测）。 */
function readActiveAcpSessionId(rcsSessionId: string): string | null {
  const ydoc = docManager.getSessionYdoc(rcsSessionId);
  if (!ydoc) return null;
  // `session/sessionId` 是概览字段，`agent/acpSessionId` 是运行态字段：前者先写入、后者随 agent 状态更新，
  // 两者在正常流程下一致，取先出现的那个（Doc 结构见 chat-channel 的 SessionInfoProjection）。
  // 结构键在 Doc 刚创建时可能尚未写入，故按「可能缺失」读取，不做非空断言。
  //
  // 已知耦合：这里直接读 Session Doc 的投影形状，而不是走 chat-channel 的公开读取函数——该包目前只向写入侧
  // 暴露这些键（`chat-writer` 写、`doc-manager` 内部读），没有对外读取入口；本读取是**只读且无副作用**的。
  // 若 chat-channel 日后提供「读活跃 ACP session id」的公开函数，应改用它，避免形状漂移时两处各自发现。
  const root = getSessionRoot(ydoc);
  return readNestedString(root.get("session"), "sessionId") ?? readNestedString(root.get("agent"), "acpSessionId");
}

/** 生产实现：进程级 DocManager 单例上的只读查询。 */
export const traceSessionLookup: TraceSessionLookup = {
  resolveActiveAcpSessionId: readActiveAcpSessionId,
};
