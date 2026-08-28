/**
 * 活跃 SDK Query 注册表：按 sessionId 精确中断，多会话并发互不干扰。
 *
 * claude-acp-adapter 同一连接上可并发运行多个 prompt（workflow / 多标签页），
 * 单字段 currentQuery 会被后启动的 query 覆盖，而 cancel RPC 携带 sessionId
 * （acp-dispatcher.handleCancel）却无法定位目标 query。注册表以 sessionId 为键，
 * cancel 只中断目标 session 的 query。
 *
 * 泛型仅约束 interrupt() 签名，测试可用 fake Query 直接构造注入（不 mock 模块）。
 */
export class ActiveQueryRegistry<T extends { interrupt(): Promise<void> }> {
  private readonly queries = new Map<string, { query: T; cancelRequested: boolean }>();
  /**
   * sessionId 为 null（session 尚未建立）时的兜底键：该 query 仍可被 cancel 中断。
   * 注意：多个 null-session query 并发会互相覆盖（register 覆盖 + cancel(null) 命中
   * 最近注册者），此键仅保证"兜底可取消"，不承诺并发精确性——正常 prompt 必有 sessionId。
   */
  private static readonly NO_SESSION_KEY = "__no_session__";
  /** 同 session 二次注册的告警回调（协议违规可观测），不提供时静默 */
  private readonly reportError?: (message: string, error?: unknown) => void;

  constructor(options: { reportError?: (message: string, error?: unknown) => void } = {}) {
    this.reportError = options.reportError;
  }

  private keyOf(sessionId: string | null): string {
    return sessionId ?? ActiveQueryRegistry.NO_SESSION_KEY;
  }

  /**
   * prompt 开始时注册活跃 query。
   * 同一 session 并发第二次 prompt 属协议违规（同一 turn 不应双 prompt），
   * 此时后注册覆盖先注册，旧 query 不再可中断——覆盖前调用 reportError 告警
   * （而非静默），便于定位 workflow / 多标签页的异常并发。
   */
  register(sessionId: string | null, query: T): void {
    const key = this.keyOf(sessionId);
    if (this.queries.has(key)) {
      this.reportError?.(
        `[ActiveQueryRegistry] duplicate register for session "${key}": concurrent prompts ` +
          "on the same session violate the single-active-turn protocol; the previous query is no longer interruptible",
      );
    }
    this.queries.set(key, { query, cancelRequested: false });
  }

  /** 读取该 session 的 query 是否被 cancel 标记过（prompt 收尾时据此决定 stopReason） */
  peekCancelRequested(sessionId: string | null): boolean {
    return this.queries.get(this.keyOf(sessionId))?.cancelRequested ?? false;
  }

  /** prompt 循环结束后注销（无论正常结束还是异常，调用方需保证成对调用） */
  unregister(sessionId: string | null): void {
    this.queries.delete(this.keyOf(sessionId));
  }

  /**
   * 中断指定 session 的活跃 query；无活跃 query 返回 false（no-op，不抛错）。
   * 重复 cancel 幂等：已标记过的 query 不重复调用 interrupt。
   * interrupt 失败（query 已被 SDK 内部清理 / transport 抖动）不抛错：
   * cancelRequested 已置位，prompt 收尾仍会读到标记返回 stopReason:"cancelled"，
   * 取消语义不依赖 interrupt 的返回结果。
   */
  async cancel(sessionId: string | null): Promise<boolean> {
    const entry = this.queries.get(this.keyOf(sessionId));
    if (!entry) return false;
    if (entry.cancelRequested) return true;
    entry.cancelRequested = true;
    try {
      await entry.query.interrupt();
    } catch {
      // interrupt 失败不阻塞 cancel RPC：标记已置位，for-await 收尾（adapter 的
      // finally 注销路径）会读取标记返回 stopReason:"cancelled"；若此处抛错，
      // dispatcher 会回 error RPC，前端将失去终态事件（只能等超时兜底）。
    }
    return true;
  }
}
