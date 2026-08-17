import type { ChangedFile } from "./extract-changed-files";

/**
 * chat:stats 事件摘要协议（SP-B7）。
 *
 * 派发方（ChatInterface）不再携带完整 entries（流式期间 ~20 次/秒、体积 O(会话长度)），
 * 只派发该轻量摘要；消费方（ChatArea → ArtifactsPanel）据此投影 changedFiles。
 * agentName 用于消费方按 agent 过滤，防止跨 agent keep-alive 槽位互相污染。
 */
export interface ChatStatsSummary {
  agentName: string | undefined;
  modelName: string | undefined;
  entryCount: number;
  changedFiles: ChangedFile[];
}

/** 摘要幂等签名：内容未变时派发方可跳过重复派发 */
export function chatStatsSignature(summary: ChatStatsSummary): string {
  return `${summary.agentName ?? ""}\u0000${summary.modelName ?? ""}\u0000${summary.entryCount}\u0000${summary.changedFiles
    .map((f) => `${f.type}:${f.path}`)
    .join(",")}`;
}

/**
 * chat:stats 摘要派发器 — trailing 节流 + 幂等跳过 + 关键时刻补发。
 *
 * - `update(summary)`：摘要签名与上一次相同时直接跳过（幂等）；
 *   签名变化时更新待发摘要并进入 1 秒 trailing 窗口——窗口内多次变化只替换
 *   待发摘要（不提前派发），到期一次性派发最终态，实际派发间隔恒 ≥ windowMs。
 * - `flush()`：立即派发待发摘要（组件卸载时调用，保证节流窗口不吞掉最终态）。
 *   注意：不能在普通依赖变化的 cleanup 中调用，否则每次变化都会立即派发、
 *   节流完全失效；仅卸载路径需要补发。
 *
 * windowMs 可注入用于测试；生产路径使用默认 1000ms。
 */
export class ChatStatsDispatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSummary: ChatStatsSummary | null = null;
  private lastKey: string | null = null;

  constructor(
    private readonly options: {
      windowMs?: number;
      emit?: (summary: ChatStatsSummary) => void;
    } = {},
  ) {}

  update(summary: ChatStatsSummary): void {
    const key = chatStatsSignature(summary);
    if (key === this.lastKey) return;
    this.lastKey = key;
    // trailing-only：窗口内变化只替换待发摘要，不提前派发
    this.pendingSummary = summary;
    if (this.timer == null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const pending = this.pendingSummary;
        this.pendingSummary = null;
        if (pending) this.emit(pending);
      }, this.options.windowMs ?? 1000);
    }
  }

  /** 立即派发待发摘要（无待发时为空操作） */
  flush(): void {
    if (this.timer == null) return;
    clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pendingSummary;
    this.pendingSummary = null;
    if (pending) this.emit(pending);
  }

  private emit(summary: ChatStatsSummary): void {
    const sink = this.options.emit ?? ((s) => window.dispatchEvent(new CustomEvent("chat:stats", { detail: s })));
    sink(summary);
  }
}
