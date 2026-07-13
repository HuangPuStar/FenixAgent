import { MemoryStore } from "./memory-store";
import { RedisStore } from "./redis-store";
import type { TransportStore } from "./types";

let _store: TransportStore | null = null;

/** 获取单例 TransportStore 实例。根据 RCS_REDIS_URL 环境变量自动选择 MemoryStore 或 RedisStore。 */
export function getTransportStore(): TransportStore {
  if (_store) return _store;
  const redisUrl = process.env.RCS_REDIS_URL;
  _store = redisUrl ? new RedisStore({ url: redisUrl }) : new MemoryStore();
  return _store;
}

/** 关闭并释放 TransportStore 单例。 */
export async function closeTransportStore(): Promise<void> {
  if (_store) {
    await _store.close();
    _store = null;
  }
}
