// packages/chat-channel/src/state/projection-fence.ts
// 投影生命周期栅栏：用 closeEpoch / replaceEpoch 区分 close、replace 成功、replace 失败。
//
// 单一计数器无法表达三种语义：close 必须让在途 open 与 replace 都放弃；replace 成功要让
// 在途 open 返回 map 中的新世代 Doc；replace 失败（active generation 未变）不得误伤在途
// open，其加载结果仍可安装。replaceEpoch 只在换代开始/提交时递增，close 只递增
// closeEpoch，因此 open 能区分“换代了”与“关闭了”。
//
// open 在加载开始时持有 fence 对象引用与 epoch 快照；close/closeAll 即使随后从 Map 中移除
// 登记，在途 open 仍能通过引用看到递增后的 epoch。

export type ProjectionDocKind = "chat" | "session";

export interface DocFence {
  /** close / closeAll 递增：关闭优先，在途 open 与 replace 都必须放弃。 */
  closeEpoch: number;
  /** replace 开始与成功提交时递增：仅表示换代发生过，不代表关闭。 */
  replaceEpoch: number;
}

export interface FenceSnapshot {
  readonly fence: DocFence;
  readonly closeEpoch: number;
  readonly replaceEpoch: number;
  readonly shutdownEpoch: number;
}

export interface ReplacementAttempt {
  readonly chat: DocFence;
  readonly session: DocFence;
  readonly chatCloseEpoch: number;
  readonly sessionCloseEpoch: number;
  readonly shutdownEpoch: number;
}

export class ProjectionFences {
  private readonly chatFences = new Map<string, DocFence>();
  private readonly sessionFences = new Map<string, DocFence>();
  /** 每个 rcsSessionId 最近一次在途换代；open 在安装前等待它落定。 */
  private readonly replacements = new Map<string, Promise<unknown>>();
  /** closeAll 递增：清空登记后，在途 open 仍须观察到“已整体关闭”。 */
  private shutdownEpoch = 0;

  private mapOf(kind: ProjectionDocKind): Map<string, DocFence> {
    return kind === "chat" ? this.chatFences : this.sessionFences;
  }

  fence(kind: ProjectionDocKind, rcsSessionId: string): DocFence {
    const map = this.mapOf(kind);
    let fence = map.get(rcsSessionId);
    if (!fence) {
      fence = { closeEpoch: 0, replaceEpoch: 0 };
      map.set(rcsSessionId, fence);
    }
    return fence;
  }

  snapshot(kind: ProjectionDocKind, rcsSessionId: string): FenceSnapshot {
    const fence = this.fence(kind, rcsSessionId);
    return {
      fence,
      closeEpoch: fence.closeEpoch,
      replaceEpoch: fence.replaceEpoch,
      shutdownEpoch: this.shutdownEpoch,
    };
  }

  /** 关闭后（含 closeAll）在途 open 不得再安装 Doc。 */
  isClosed(snapshot: FenceSnapshot): boolean {
    return snapshot.fence.closeEpoch !== snapshot.closeEpoch || snapshot.shutdownEpoch !== this.shutdownEpoch;
  }

  /**
   * 关闭单个 Doc。没有登记说明没有在途 open/replace 持有引用，无需凭空创建条目。
   * 删除登记避免 fence Map 随会话生命周期无界增长；在途持有者仍能看到递增后的 epoch。
   */
  close(kind: ProjectionDocKind, rcsSessionId: string): void {
    const map = this.mapOf(kind);
    const fence = map.get(rcsSessionId);
    if (!fence) return;
    fence.closeEpoch += 1;
    map.delete(rcsSessionId);
  }

  /** 总体关闭：先让所有在途 open/replace 观察到关闭，再清空登记。 */
  closeAll(): void {
    this.shutdownEpoch += 1;
    for (const map of [this.chatFences, this.sessionFences]) {
      for (const fence of map.values()) fence.closeEpoch += 1;
      map.clear();
    }
  }

  beginReplacement(rcsSessionId: string): ReplacementAttempt {
    const chat = this.fence("chat", rcsSessionId);
    const session = this.fence("session", rcsSessionId);
    chat.replaceEpoch += 1;
    session.replaceEpoch += 1;
    return {
      chat,
      session,
      chatCloseEpoch: chat.closeEpoch,
      sessionCloseEpoch: session.closeEpoch,
      shutdownEpoch: this.shutdownEpoch,
    };
  }

  /** replace 提交前校验：publish await 窗口内发生 close 时，关闭优先。 */
  assertReplacementOpen(attempt: ReplacementAttempt): void {
    if (
      attempt.chat.closeEpoch !== attempt.chatCloseEpoch ||
      attempt.session.closeEpoch !== attempt.sessionCloseEpoch ||
      attempt.shutdownEpoch !== this.shutdownEpoch
    ) {
      throw new Error("projection replacement was superseded by close");
    }
  }

  /** 换代成功提交：让在换代开始后、提交前才完成加载的 open 观察到第二次变化。 */
  commitReplacement(attempt: ReplacementAttempt): void {
    attempt.chat.replaceEpoch += 1;
    attempt.session.replaceEpoch += 1;
  }

  /**
   * 登记并执行一次换代。open 通过 `waitForReplacement` 等待它落定后重新读取 map/epoch：
   * 成功时 map 已有新世代 Doc；失败时 active generation 未变，open 可安装自己的加载结果。
   */
  async runReplacement<T>(rcsSessionId: string, run: (attempt: ReplacementAttempt) => Promise<T>): Promise<T> {
    const attempt = this.beginReplacement(rcsSessionId);
    const promise = run(attempt);
    this.replacements.set(rcsSessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.replacements.get(rcsSessionId) === promise) this.replacements.delete(rcsSessionId);
    }
  }

  hasReplacement(rcsSessionId: string): boolean {
    return this.replacements.has(rcsSessionId);
  }

  /** 等待在途换代落定；失败由调用方通过 map/epoch 判定，不在等待点吞掉关闭语义。 */
  async waitForReplacement(rcsSessionId: string): Promise<void> {
    for (;;) {
      const inFlight = this.replacements.get(rcsSessionId);
      if (!inFlight) return;
      try {
        await inFlight;
      } catch {
        // 换代失败 / 被 close 取消：open 继续用 epoch 与 map 判断自己的加载结果是否仍权威。
      }
      if (this.replacements.get(rcsSessionId) === inFlight) return;
    }
  }
}
