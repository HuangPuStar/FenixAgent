import { SpanStatusCode, trace } from "@opentelemetry/api";
import { historyRestoreDuration } from "../metrics";
import { type SyncScope, scopeKey } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";
import type { SyncHistoryRecord } from "./host-session";
import type { SyncScopeRuntime } from "./scope-runtime";

/** 以历史已提交且代次可读取为恢复完成，不额外扫描消息内容或复制计时。 */
export async function commitHostHistory(input: {
  runtime: SyncScopeRuntime;
  store: ProjectionStore;
  scope: SyncScope;
  owner: string;
  acpSessionId: string;
  records: readonly SyncHistoryRecord[];
}): Promise<{ generation: string; pointerRevision: number; contentDocIds: readonly string[] }> {
  const start = performance.now();
  return trace.getTracer("@fenix/chat-channel").startActiveSpan("history.restore", async (span) => {
    let result = "failure";
    try {
      await input.runtime.history.begin({
        scope: input.scope,
        acpSessionId: input.acpSessionId,
        owner: input.owner,
        leaseTtlMs: 30_000,
      });
      for (const record of input.records) await input.runtime.history.accept(record.value, record.meta);
      await input.runtime.history.receivingComplete();
      await input.runtime.history.buildAndCommit();
      const committed = await input.runtime.history.finalize();
      const generation = await input.store.readGeneration(scopeKey(input.scope), committed.generation);
      result = "success";
      return {
        generation: committed.generation,
        pointerRevision: committed.pointerRevision,
        contentDocIds: generation?.entryRefs.contentDocIds ?? [],
      };
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      historyRestoreDuration.record((performance.now() - start) / 1000, { mode: "stable_history", result });
      span.setAttribute("result", result);
      span.end();
    }
  });
}
