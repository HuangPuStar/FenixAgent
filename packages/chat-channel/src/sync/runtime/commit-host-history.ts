import { SpanStatusCode, trace } from "@opentelemetry/api";
import { historyRestoreDuration } from "../metrics";
import { SyncProtocolError } from "../protocol/errors";
import { type SyncScope, scopeKey } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";
import type { SyncHistoryRecord } from "./host-session";
import type { SyncScopeRuntime } from "./scope-runtime";

/** 以历史已提交且代次可读取为恢复完成，不额外扫描消息内容或复制计时。 */
export async function commitHostHistory(input: {
  runtime: Pick<SyncScopeRuntime, "history">;
  store: ProjectionStore;
  scope: SyncScope;
  owner: string;
  acpSessionId: string;
  records: AsyncIterable<SyncHistoryRecord> | Iterable<SyncHistoryRecord>;
}): Promise<{ generation: string; pointerRevision: number; contentDocIds: readonly string[] }> {
  const start = performance.now();
  return trace.getTracer("@fenix/chat-channel").startActiveSpan("history.restore", async (span) => {
    let result = "failure";
    let loadId: string | undefined;
    try {
      const begun = await input.runtime.history.begin({
        scope: input.scope,
        acpSessionId: input.acpSessionId,
        owner: input.owner,
        leaseTtlMs: 30_000,
      });
      loadId = begun.loadId;
      // 阶段间可能发生取消及新 load；迟到流程不能接管下一轮的构建或发布。
      const requireOwnership = () => {
        const status = input.runtime.history.status();
        if (status.loadId !== loadId || status.state === "failed")
          throw new SyncProtocolError("IMPORT_INCOMPLETE", { message: "history restore no longer owns its load" });
      };
      await input.runtime.history.acceptRecords(input.records);
      requireOwnership();
      await input.runtime.history.receivingComplete();
      requireOwnership();
      await input.runtime.history.buildAndCommit();
      requireOwnership();
      const committed = await input.runtime.history.finalize();
      const generation = await input.store.readGeneration(scopeKey(input.scope), committed.generation);
      result = "success";
      return {
        generation: committed.generation,
        pointerRevision: committed.pointerRevision,
        contentDocIds: generation?.entryRefs.contentDocIds ?? [],
      };
    } catch (error) {
      if (loadId !== undefined) await input.runtime.history.abort(error, loadId);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      historyRestoreDuration.record((performance.now() - start) / 1000, { mode: "stable_history", result });
      span.setAttribute("result", result);
      span.end();
    }
  });
}
