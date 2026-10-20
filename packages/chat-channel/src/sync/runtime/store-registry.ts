// packages/chat-channel/src/sync/runtime/store-registry.ts
// 同 scope 多连接的共享投影存储：同一进程内的多标签页必须看到同一份已提交事实。
//
// 边界（主控裁决）：共享 store 与「一次历史引导」，**不共享 runtime**。每个连接仍有独立的 provider
// 会话、额度与订阅；只有单写者租约是 scope 级竞争点——抢不到租约的连接按 follower 降级（丢弃实时
// 入口事件），它的 tick 从共享 store 的已提交边界追赶，因此多标签页仍能得到同一批更新。
//
// 生命周期：引用计数归零时丢弃条目（内存 adapter 没有持久化）；若引导仍在途则保留到它落定，
// 避免「导入成功但 store 已被最后一个连接释放」产生无人可用的代次。

import type { RandomSource } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import type { SyncScope } from "../protocol/identity";
import { scopeKey } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";

/** 共享 store 句柄：引用计数由创建它的连接持有。 */
export interface SharedProjectionStore {
  readonly store: ProjectionStore;
  /**
   * 每个 store 只执行一次的引导任务（历史导入）。
   *
   * 并发调用共享同一个 Promise；失败不缓存——下一次连接可以重试，失败本身不会被伪装成已完成。
   * `null` 结果表示「源没有可导入内容」，同样视为已完成，避免每次重连都扫描旧投影。
   */
  bootstrap<T>(task: () => Promise<T>): Promise<T>;
  /** 释放一次引用；归零后丢弃 store。幂等。 */
  release(): void;
}

interface RegistryEntry {
  readonly store: ProjectionStore;
  refs: number;
  bootstrapSettled: boolean;
  bootstrapValue: unknown;
  bootstrapInflight: Promise<unknown> | null;
}

/** 进程内共享 store 注册表；按已认证 scope 的存储键隔离。 */
export class SyncStoreRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  /**
   * 取得（或创建）scope 对应的共享 store，并把引用计数 +1。
   *
   * `binding` 是投影代次（宿主用旧 Chat/Session Doc 的 generation）：同一 scope 内
   * `load_session` / `create_session` 会整体换代，新代次不得复用旧 store 与旧历史引导，
   * 否则新会话的实时事件会追加到上一会话的时间线上。
   */
  acquire(scope: SyncScope, createStore: () => ProjectionStore, binding?: string): SharedProjectionStore {
    const scopeKeyValue = scopeKey(scope);
    const key = binding === undefined || binding.length === 0 ? scopeKeyValue : `${scopeKeyValue}#${binding}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        store: createStore(),
        refs: 0,
        bootstrapSettled: false,
        bootstrapValue: null,
        bootstrapInflight: null,
      };
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    const owned = entry;
    let released = false;
    return {
      store: owned.store,
      bootstrap<T>(task: () => Promise<T>): Promise<T> {
        return runBootstrap(owned, task);
      },
      release: (): void => {
        if (released) return;
        released = true;
        owned.refs -= 1;
        if (owned.refs <= 0 && owned.bootstrapInflight === null) {
          // 只删除自己登记的那一条：同 key 可能已被后来者重新创建。
          if (this.entries.get(key) === owned) this.entries.delete(key);
          return;
        }
        // 引用归零但引导仍在途：等它落定后再决定是否丢弃（成功或失败都不影响已建立连接）。
        if (owned.refs <= 0) {
          const cleanup = (): void => {
            if (owned.refs <= 0 && this.entries.get(key) === owned) this.entries.delete(key);
          };
          // 用 then 的成功/失败双回调代替 finally：finally 会派生一个未处理的 rejected promise。
          void owned.bootstrapInflight?.then(cleanup, cleanup);
        }
      },
    };
  }

  /** 仅供观测/测试：当前驻留的 scope 数。 */
  get size(): number {
    return this.entries.size;
  }
}

function runBootstrap<T>(entry: RegistryEntry, task: () => Promise<T>): Promise<T> {
  if (entry.bootstrapSettled) return Promise.resolve(entry.bootstrapValue as T);
  if (entry.bootstrapInflight !== null) return entry.bootstrapInflight as Promise<T>;
  const run = task().then(
    (value) => {
      entry.bootstrapSettled = true;
      entry.bootstrapValue = value;
      entry.bootstrapInflight = null;
      return value;
    },
    (error: unknown) => {
      entry.bootstrapInflight = null;
      throw error;
    },
  );
  entry.bootstrapInflight = run;
  return run;
}

/** 基础 owner 加随机后缀：共享 store 下每个连接都必须是独立写者，否则同 owner 会被当成续租。 */
export function uniqueOwner(base: string, random: RandomSource): string {
  let suffix = "";
  for (const byte of random.bytes(4)) suffix += byte.toString(16).padStart(2, "0");
  return `${base}#${suffix}`;
}

/** follower 判定：写权被同 scope 的另一个连接持有，应降级到共享边界追赶而非停止投影。 */
export function isScopeBusy(error: unknown): boolean {
  return error instanceof SyncProtocolError && error.code === "SCOPE_BUSY";
}
