import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AUTH_PREFERRED_METHOD_STORAGE_KEY,
  getPreferredAuthMethod,
  setPreferredAuthMethod,
} from "../lib/auth-preference";

describe("auth preference storage", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
  });

  afterEach(() => {
    localStorage.removeItem(AUTH_PREFERRED_METHOD_STORAGE_KEY);
  });

  // 应在没有缓存时默认展示邮箱登录入口，避免首屏状态不确定。
  test("falls back to email when no preference is stored", () => {
    expect(getPreferredAuthMethod()).toBe("email");
  });

  // 应记住用户上次使用的登录方式，便于手机号用户下次直接进入对应 tab。
  test("persists the preferred auth method", () => {
    setPreferredAuthMethod("phone");
    expect(getPreferredAuthMethod()).toBe("phone");
  });
});
