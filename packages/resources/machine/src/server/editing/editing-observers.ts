import type { EditingScope } from "@fenix/file-editing/contracts";
import { createWorkspaceObserver } from "@fenix/file-editing/server";
import { createLogger } from "@fenix/logger";
import { publishFileChanged, publishInvalidateAllLimited } from "../services/file-event-limiter";
import { getRemoteMachineId } from "../services/remote-file-service";
import { resolveWorkspacePath } from "../services/workspace-fs";

const logger = createLogger("machine-file-observer");
type Observer = ReturnType<typeof createWorkspaceObserver>;
type Observe = typeof createWorkspaceObserver;
interface ObserverDependencies {
  root(scope: EditingScope): Promise<string | null>;
  observe: Observe;
  publish(scope: EditingScope, path: string, kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir"): void;
}

/** Authorized environment subscriptions own references; delayed startup cannot revive a released scope. */
export function createMachineEditingObservers(deps: ObserverDependencies) {
  const entries = new Map<string, { refs: number; live: boolean; observer?: Observer }>();
  const pending = new Set<Promise<void>>();
  const closed = new WeakSet<Observer>();
  const close = (observer: Observer) => {
    if (closed.has(observer)) return;
    closed.add(observer);
    const completion = observer
      .close()
      .catch((error: unknown) =>
        logger.error("Observer release failed", { errorType: error instanceof Error ? error.name : "UnknownError" }),
      );
    pending.add(completion);
    void completion.finally(() => pending.delete(completion));
  };
  return {
    retain(scope: EditingScope): () => void {
      const key = JSON.stringify([scope.organizationId, scope.userId, scope.environmentId]);
      let entry = entries.get(key);
      if (entry) entry.refs++;
      else {
        // A hard ceiling bounds filesystem handles even when a client subscribes to many environments.
        if (entries.size >= 200) {
          publishInvalidateAllLimited(scope.environmentId);
          return () => {};
        }
        entry = { refs: 1, live: true };
        entries.set(key, entry);
        const current = entry;
        const starting = (async () => {
          const root = await deps.root(scope);
          if (!root || !current.live) return;
          const observer = deps.observe({
            root,
            onChange: (path, kind) => {
              if (current.live) deps.publish(scope, path, kind);
            },
          });
          current.observer = observer;
          await observer.ready;
          if (!current.live) close(observer);
        })().catch((error: unknown) => {
          logger.warn("Workspace observation unavailable", {
            environmentId: scope.environmentId,
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
          publishInvalidateAllLimited(scope.environmentId);
        });
        pending.add(starting);
        void starting.finally(() => pending.delete(starting));
      }
      const current = entry;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        current.refs--;
        if (current.refs > 0) return;
        current.live = false;
        if (entries.get(key) === current) entries.delete(key);
        if (current.observer) close(current.observer);
      };
    },
    async dispose() {
      for (const entry of entries.values()) {
        entry.live = false;
        if (entry.observer) close(entry.observer);
      }
      entries.clear();
      await Promise.allSettled([...pending]);
    },
  };
}

/** Local direct writes join the existing environment event queue; remote routing never falls back locally. */
export const machineEditingObservers = createMachineEditingObservers({
  async root(scope) {
    if (await getRemoteMachineId(scope.environmentId)) return null;
    return (await resolveWorkspacePath(scope.environmentId, "."))?.workspaceDir ?? null;
  },
  observe: createWorkspaceObserver,
  publish(scope, path, kind) {
    publishFileChanged(scope.environmentId, {
      path,
      kind: kind === "unlink" || kind === "unlinkDir" ? "delete" : kind === "addDir" ? "mkdir" : "write",
      source: "external",
    });
  },
});
