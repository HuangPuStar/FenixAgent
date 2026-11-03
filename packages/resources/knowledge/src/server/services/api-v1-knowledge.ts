import type { KnowledgeBaseListItem } from "./knowledge-base";
import { getKnowledgeProvider } from "./knowledge-provider/registry";
import { resolveRagflowApiKey } from "./ragflow-key";

/** Check only the authorized page, with bounded workers and abortable upstream requests. */
export async function checkApiKnowledgeStatus(
  items: KnowledgeBaseListItem[],
  signal?: AbortSignal,
  resolveKey = resolveRagflowApiKey,
) {
  const provider = getKnowledgeProvider();
  const results = new Array<ReturnType<typeof project>>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        signal?.throwIfAborted();
        const index = cursor++;
        const item = items[index];
        let exists: boolean | null = null;
        if (item.remoteId && provider.getDataset) {
          const timer = new AbortController();
          const deadline = setTimeout(() => timer.abort(), 3000);
          const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
          let onAbort: () => void = () => {};
          const cancelled = new Promise<never>((_, reject) => {
            onAbort = () => reject(new DOMException("Knowledge check cancelled", "AbortError"));
            combined.addEventListener("abort", onAbort, { once: true });
          });
          try {
            const work = (async () => {
              const apiKey = await resolveKey("global", item.userId, item.organizationId ?? "");
              combined.throwIfAborted();
              return provider.getDataset!({ datasetId: item.remoteId!, apiKey, signal: combined });
            })();
            exists = (await Promise.race([work, cancelled])) !== null;
          } catch (error) {
            console.error("[api-knowledge] Remote status unavailable", error, { knowledgeBaseId: item.id });
            signal?.throwIfAborted();
          } finally {
            clearTimeout(deadline);
            combined.removeEventListener("abort", onAbort);
          }
        }
        results[index] = project(item, exists);
      }
    }),
  );
  return results;
}
function project(item: KnowledgeBaseListItem, remoteExists: boolean | null) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    provider: item.provider,
    status: item.status,
    resourcesCount: item.resourcesCount,
    bindingsCount: item.bindingsCount,
    embeddingModel: item.embeddingModel ?? null,
    parseMethod: item.parseMethod ?? null,
    chunkMethod: item.chunkMethod ?? null,
    remoteExists,
  };
}
