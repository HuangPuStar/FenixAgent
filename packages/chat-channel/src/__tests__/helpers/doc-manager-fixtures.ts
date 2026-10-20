// packages/chat-channel/src/__tests__/helpers/doc-manager-fixtures.ts
// DocManager open / fence 回归测试的共享构造器：Redis 双、时序闸门、快照与 manager 工厂。
//
// 只被 doc-manager-open-fence.test.ts 与 doc-manager-fastpath.test.ts 使用；
// 保持与拆分前完全一致的时序控制能力，避免测试语义在拆分中漂移。

import * as Y from "yjs";
import { readLegacyCommittedHistory } from "../../channel/legacy-chat-history";
import type { SnapshotPersistConfig } from "../../persist/snapshot-config";
import {
  appendEntryText,
  ensureEntry,
  initChatDocStructure,
  initSessionDocStructure,
  setEntryStatus,
} from "../../state/chat-writer";
import { DocManager } from "../../state/doc-manager";
import { FakeRedis } from "./fake-redis";

export const GENERATION = "gen_fence_old";
export const REPLACED_EXTERNALLY = "gen_fence_external";
export const SNAPSHOT_CONFIG: SnapshotPersistConfig = { intervalMs: 2_000, idleMs: 500, ttlSeconds: 604_800 };

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** FakeRedis 默认 EVAL 返回 0；生产 CAS 需要真正比较并推进 active generation。 */
export class ProdRedis extends FakeRedis {
  override async eval(_script?: unknown, numKeys?: number, ...args: unknown[]): Promise<number> {
    if (numKeys !== 1) return 0;
    const [key, expected, next] = args as [string, string, string];
    if ((await this.get(key)) !== expected) return 0;
    await this.set(key, next);
    return 1;
  }
}

/** 让 publishActiveGeneration 停在 await 窗口，用于覆盖 open / close 与 publish 的竞争。 */
export class GatedEvalRedis extends ProdRedis {
  evalStarted = false;
  /** active-generation 读取次数，用于确认 open 已完成水合并进入安装前等待。 */
  activeGenGets = 0;
  private readonly gate = deferred();
  private readonly started = deferred();

  override async eval(script?: unknown, numKeys?: number, ...args: unknown[]): Promise<number> {
    if (numKeys === 1) {
      this.evalStarted = true;
      this.started.resolve();
      await this.gate.promise;
    }
    return super.eval(script, numKeys, ...args);
  }

  override get(key: string): Promise<string | null> {
    if (key.startsWith("yjs:active-generation:")) this.activeGenGets += 1;
    return super.get(key);
  }

  releaseEval(): void {
    this.gate.resolve();
  }
}

/** 让快路径的 active generation 复核停在 await 窗口，验证并发 open 共享同一 opening。 */
export class GatedFastPathRedis extends ProdRedis {
  gatedGets = 0;
  private armed = false;
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  arm(): void {
    this.armed = true;
    this.gatedGets = 0;
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.armed = false;
    this.releaseGate?.();
  }

  override async get(key: string): Promise<string | null> {
    const value = await super.get(key);
    if (this.armed && key.startsWith("yjs:active-generation:")) {
      this.gatedGets += 1;
      await this.gate;
    }
    return value;
  }
}

/** 让已驻留 Doc 快路径的 active generation 只读复核失败，模拟 Redis 短暂不可用。 */
export class FailActiveGenerationRedis extends ProdRedis {
  failActiveGeneration = false;

  override get(key: string): Promise<string | null> {
    if (this.failActiveGeneration && key.startsWith("yjs:active-generation:")) {
      return Promise.reject(new Error("Redis connection lost (simulated)"));
    }
    return super.get(key);
  }
}

/** 在 Doc 安装完成后、open 外层续体前触发 close，复现「返回已销毁 Doc」的窗口。 */
export class ReturnWindowRedis extends ProdRedis {
  private bufferDone = false;
  private generationGetsAfterBuffer = 0;

  constructor(private readonly onWindow: () => void) {
    super();
  }

  override async getBuffer(key: string): Promise<Buffer | null> {
    const value = await super.getBuffer(key);
    this.bufferDone = true;
    return value;
  }

  override get(key: string): Promise<string | null> {
    const base = super.get(key);
    if (!this.bufferDone || !key.startsWith("yjs:active-generation:")) return base;
    this.generationGetsAfterBuffer += 1;
    if (this.generationGetsAfterBuffer !== 2) return base;
    return new Promise<string | null>((resolve) => {
      base.then((value) => {
        resolve(value);
        // get → getActiveGeneration → isGenerationCurrent + finalize 返回共 4 层微任务：
        // close 恰好落在安装完成之后、openChat/openSession 外层续体之前。
        queueMicrotask(() =>
          queueMicrotask(() =>
            queueMicrotask(() =>
              queueMicrotask(() => {
                this.onWindow();
              }),
            ),
          ),
        );
      });
    });
  }
}

/**
 * 在指定旧世代 Doc 的 Y.Doc.destroy 处暂停。此时旧 Doc 已从 map 删除、provider 已释放，
 * 但 openInternal 尚未捕获内部 fence 快照，正好暴露快路径删除后的关闭窗口。
 */
export function gateYDocDestroy(guid: string): { hit: Promise<void>; release: () => void; restore: () => void } {
  const original = Y.Doc.prototype.destroy;
  const hit = deferred();
  const gate = deferred();
  Y.Doc.prototype.destroy = function (this: Y.Doc) {
    if (this.guid !== guid) return original.call(this);
    hit.resolve();
    return gate.promise.then(() => original.call(this));
  };
  return {
    hit: hit.promise,
    release: gate.resolve,
    restore: () => {
      Y.Doc.prototype.destroy = original;
    },
  };
}

function snapshotOf(init: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  init(doc);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export function chatSnapshotWithText(text: string): Uint8Array {
  return snapshotOf((doc) => {
    initChatDocStructure(doc);
    ensureEntry(doc, { entryId: "turn-1:user", turnId: "turn-1", kind: "message", role: "user" });
    appendEntryText(doc, "turn-1:user", "text:1", "text", text);
    setEntryStatus(doc, "turn-1:user", "completed");
  });
}

export function sessionSnapshot(): Uint8Array {
  return snapshotOf(initSessionDocStructure);
}

export function historyValues(ydoc: Y.Doc): string[] {
  return readLegacyCommittedHistory(ydoc).map((record) => record.value);
}

export function createManager(
  getRedis: () => FakeRedis | null,
  options?: {
    onYjsUpdate?: (docName: string, update: Uint8Array) => void;
    onError?: (context: string, err: unknown) => void;
  },
): DocManager {
  const manager = new DocManager({
    getRedis: () => getRedis() as never,
    onYjsUpdate: options?.onYjsUpdate ?? null,
    onError: options?.onError ?? (() => {}),
    onLog: () => {},
  });
  manager.setSnapshotPersistConfigSource(() => SNAPSHOT_CONFIG);
  return manager;
}
