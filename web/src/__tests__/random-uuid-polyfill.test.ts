import { afterEach, describe, expect, test } from "bun:test";
import { installRandomUUIDPolyfill } from "../lib/random-uuid-polyfill";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// randomUUID 是 Crypto.prototype 上的原型方法（Web 标准，Bun / 浏览器一致），
// 且 Bun 中该原型属性不可配置，无法 delete；改为在实例上遮蔽（defineProperty
// 为 undefined），等效模拟非 secure context 下 crypto.randomUUID 缺失。
function simulateNonSecureContext(): void {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

function restoreEnvironment(): void {
  // 移除实例遮蔽属性（若存在），恢复原型方法的可见性
  delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
}

// 模拟非 secure context（HTTP）环境：移除 crypto.randomUUID 后安装 polyfill，
// 验证全局调用点无需感知降级即可工作。
describe("installRandomUUIDPolyfill（非 secure context 模拟）", () => {
  afterEach(() => {
    restoreEnvironment();
  });

  // crypto.randomUUID 缺失时（纯 HTTP 部署），安装后应注入可用的 UUID v4 生成器
  test("injects randomUUID when missing", () => {
    simulateNonSecureContext();
    expect(typeof globalThis.crypto.randomUUID).toBe("undefined");

    installRandomUUIDPolyfill();

    expect(typeof globalThis.crypto.randomUUID).toBe("function");
    expect(globalThis.crypto.randomUUID()).toMatch(UUID_V4_PATTERN);
  });

  // 生成的 UUID 每次应不同，避免 commandId/opId 幂等键冲突
  test("generates distinct ids across calls", () => {
    simulateNonSecureContext();
    installRandomUUIDPolyfill();

    const a = globalThis.crypto.randomUUID();
    const b = globalThis.crypto.randomUUID();
    expect(a).not.toBe(b);
  });

  // secure context 下原生实现已存在时，polyfill 不得覆盖，保证行为不被篡改
  test("keeps native implementation when already available", () => {
    installRandomUUIDPolyfill();
    // 原生实现可走通且实例上未被注入遮蔽属性（polyfill 直接 return）
    expect(globalThis.crypto.randomUUID()).toMatch(UUID_V4_PATTERN);
    expect(Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID")).toBeUndefined();
  });
});
