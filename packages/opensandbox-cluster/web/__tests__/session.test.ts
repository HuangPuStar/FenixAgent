import { expect, test } from "bun:test";
import { clearSession, readSession, saveSession } from "../session";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
// 登录固定缓存一天，刷新读取不能延长有效期。
test("restores a key until its fixed one-day expiry", () => {
  const store = storage();
  const session = saveSession(store, "secret", 1000);
  expect(readSession(store, 1001)).toEqual(session);
  expect(readSession(store, 1000 + 86400000 - 1)?.key).toBe("secret");
  expect(readSession(store, 1000 + 86400000)).toBeUndefined();
  expect(store.getItem("opensandbox-cluster-session")).toBeNull();
});
// 退出、损坏和不可用的浏览器存储均不能留下可恢复的凭据。
test("clears credentials and tolerates unavailable storage", () => {
  const store = storage();
  saveSession(store, "secret", 1000);
  clearSession(store);
  expect(readSession(store, 1001)).toBeUndefined();
  store.setItem("opensandbox-cluster-session", "not JSON");
  expect(readSession(store)).toBeUndefined();
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(saveSession(broken, "secret", 1000).key).toBe("secret");
  expect(readSession(broken)).toBeUndefined();
  expect(() => clearSession(broken)).not.toThrow();
});
