import { SyncProtocolError } from "../protocol/errors";
import type { RegistrationResult, SyncSuccessorState } from "../store/types";

/** 当前封口计划的路由提交事实；未知事务不能被之后的空读取证明为已结束。 */
export type SealingRouteOutcome = "absent" | "committed" | "unknown";

/** 封口的提交证据只在同一次计划内收敛，供上层区分普通租约过期与必须停写的交接。 */
export class SealingRouteProgress {
  private uncertain = false;
  private current: SealingRouteOutcome = "unknown";

  /** 最近一次封口计划可证明的路由结果。 */
  get outcome(): SealingRouteOutcome {
    return this.current;
  }

  /** 已存在的路由是提交证据；空读取不能排除尚未结束的未知事务。 */
  observe(state: SyncSuccessorState | null): void {
    if (state?.route) this.current = "committed";
    else if (state && !this.uncertain) this.current = "absent";
  }

  /** 原子登记的明确协议拒绝不改变已有事实，非确定异常仍可能发生在提交后。 */
  async register(action: () => Promise<RegistrationResult>): Promise<RegistrationResult> {
    const previous = this.current;
    let result: RegistrationResult;
    try {
      result = await action();
    } catch (error) {
      const rejected = error instanceof SyncProtocolError && error.code !== "COMMIT_OUTCOME_UNKNOWN";
      if (!rejected && previous !== "committed") {
        this.uncertain = true;
        this.current = "unknown";
      }
      throw error;
    }
    if (result.outcome === "committed" || result.outcome === "already-committed") this.current = "committed";
    else if (result.outcome === "unknown") {
      this.uncertain = true;
      this.current = "unknown";
    }
    return result;
  }

  /** 后续失败不能掩盖先前尚未收敛的路由事务，也不能丢掉诊断原因。 */
  failure(error: unknown): unknown {
    if (
      this.uncertain &&
      this.current !== "committed" &&
      !(error instanceof SyncProtocolError && error.code === "COMMIT_OUTCOME_UNKNOWN")
    )
      return new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", {
        message: "successor route could not be confirmed",
        cause: error,
      });
    return error;
  }
}
