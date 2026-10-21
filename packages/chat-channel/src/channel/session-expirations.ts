import { DEFAULT_PERMISSION_TIMEOUT_MS, DEFAULT_QUESTION_TIMEOUT_MS } from "../schema";
import { bumpProjectionVersion, getSessionInfo } from "../state/chat-writer";
import { applyPermissionExpiration } from "../state/permission";
import { expireQuestion } from "../state/question";
import type { SessionChannelDependencies } from "./session-connection";

/** 会话控制面超时只作用于仍在等待的原始 turn、权限和问题。 */
export class SessionExpirations {
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly permissionTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  private readonly questionTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  constructor(private readonly dependencies: SessionChannelDependencies) {}

  /** 释放逻辑会话的所有超时资源。 */
  dispose(id: string): void {
    const cancel = this.cancelTimers.get(id);
    if (cancel) clearTimeout(cancel);
    this.cancelTimers.delete(id);
    for (const map of [this.permissionTimers, this.questionTimers]) {
      for (const timer of map.get(id)?.values() ?? []) clearTimeout(timer);
      map.delete(id);
    }
  }
  /**
   * 启动取消超时兜底：Agent 长时间未确认取消（进程挂起/断连）时 turn 收敛为 interrupted，
   * 不能停留在 cancelling 中间态。回调校验 activeTurn 仍是发起取消时的 turn 且仍处
   * cancelling——用户可能已发起新 turn（旧 turn 被终结）或 Agent 已确认终态，
   * 此时不得误中断当前 turn。
   */
  armCancelTimeout(rcsSessionId: string): void {
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    const turnId = sessionDoc ? (getSessionInfo(sessionDoc).get("activeTurnId") as string | null) : null;
    if (!turnId) return;

    const timer = setTimeout(() => {
      this.cancelTimers.delete(rcsSessionId);
      const current = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
      const info = current ? getSessionInfo(current) : null;
      if (!info) return;
      if (info.get("activeTurnId") !== turnId || info.get("activeTurnStatus") !== "cancelling") return;
      this.dependencies.docManager.processNormalizedEvent(rcsSessionId, {
        type: "turn_interrupted",
        update: {},
        content: null,
      });
    }, this.dependencies.cancelTimeoutMs ?? 10_000);
    this.cancelTimers.set(rcsSessionId, timer);
  }

  // ── 权限超时（C5）──

  /**
   * 为权限请求安排过期定时器（幂等：同 permissionId 已有定时器则跳过，
   * 覆盖重放 permission_requested 帧的重复通知）。定时器到期后执行
   * pending → expired CAS 迁移并收敛 turn/工具调用状态。
   */
  armPermissionExpiry(rcsSessionId: string, permissionId: string, expiresAt: string): void {
    let timers = this.permissionTimers.get(rcsSessionId);
    if (!timers) {
      timers = new Map();
      this.permissionTimers.set(rcsSessionId, timers);
    }
    if (timers.has(permissionId)) return;

    const parsed = new Date(expiresAt).getTime();
    const timeoutMs = Number.isFinite(parsed)
      ? Math.max(0, parsed - Date.now())
      : (this.dependencies.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timers.delete(permissionId);
      this.expirePermission(rcsSessionId, permissionId);
    }, timeoutMs);
    timers.set(permissionId, timer);
  }

  /** 权限过期迁移：CAS pending → expired（重复过期无副作用），收敛由 state/permission.ts 统一处理 */
  private expirePermission(rcsSessionId: string, permissionId: string): void {
    const chatDoc = this.dependencies.docManager.getChatYdoc(rcsSessionId);
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    if (!chatDoc || !sessionDoc) return;
    const migrated = applyPermissionExpiration({ chat: chatDoc, session: sessionDoc }, permissionId);
    if (migrated) {
      bumpProjectionVersion(chatDoc.getMap("root"));
      bumpProjectionVersion(sessionDoc.getMap("root"));
    }
  }

  // ── AskUserQuestion 超时（120s，与 acp-link 自动空答案对齐）──

  /**
   * 为问题请求安排过期定时器（幂等：同 questionId 已有定时器则跳过，
   * 覆盖重放 question_requested 帧的重复通知）。定时器到期后执行
   * pending → expired CAS 迁移（投影失效，前端弹窗随状态过滤消失）。
   */
  armQuestionExpiry(rcsSessionId: string, questionId: string, expiresAt: string): void {
    let timers = this.questionTimers.get(rcsSessionId);
    if (!timers) {
      timers = new Map();
      this.questionTimers.set(rcsSessionId, timers);
    }
    if (timers.has(questionId)) return;

    const parsed = new Date(expiresAt).getTime();
    // 超时固定与 acp-link 120s 自动空答案对齐（DEFAULT_QUESTION_TIMEOUT_MS），
    // 不提供配置覆盖：acp-link 侧无对应配置项，可配会破坏两侧失效时刻一致
    const timeoutMs = Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : DEFAULT_QUESTION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timers.delete(questionId);
      this.expireQuestionTimer(rcsSessionId, questionId);
    }, timeoutMs);
    timers.set(questionId, timer);
  }

  /** 问题过期迁移：CAS pending → expired（重复过期无副作用），实现见 state/question.ts */
  private expireQuestionTimer(rcsSessionId: string, questionId: string): void {
    const chatDoc = this.dependencies.docManager.getChatYdoc(rcsSessionId);
    const sessionDoc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    if (!chatDoc || !sessionDoc) return;
    const migrated = expireQuestion({ chat: chatDoc, session: sessionDoc }, questionId);
    if (migrated) {
      bumpProjectionVersion(chatDoc.getMap("root"));
      bumpProjectionVersion(sessionDoc.getMap("root"));
    }
  }
}
