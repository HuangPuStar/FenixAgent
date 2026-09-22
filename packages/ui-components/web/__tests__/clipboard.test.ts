import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyTextToClipboard } from "@fenix/ui-components/lib/clipboard";

/**
 * 剪贴板原语的机制测试：只验证「写什么、回传什么」，**不碰真实系统剪贴板**。
 *
 * 每个用例用 `Object.defineProperty` 换掉 `navigator.clipboard`，用例结束还原原属性描述符
 * （原属性不存在就删掉）——`bun test` 在同一进程内依次求值全部测试文件，桩不允许泄漏给后续文件。
 */

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function stubClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}

afterEach(() => {
  if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, "clipboard", ORIGINAL_CLIPBOARD);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("copyTextToClipboard", () => {
  test("写入成功：回传 true，且原样写入传入的文本", async () => {
    const written: string[] = [];
    stubClipboard({
      writeText: async (text: string) => {
        written.push(text);
      },
    });

    await expect(copyTextToClipboard("org_1a2b3c")).resolves.toBe(true);
    expect(written).toEqual(["org_1a2b3c"]);
  });

  // 非安全上下文且宿主未装 polyfill 时正是这个形态：不能抛错，回传 false 让调用方给失败反馈。
  test("navigator.clipboard 缺失：回传 false 而不抛错", async () => {
    stubClipboard(undefined);
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  test("clipboard 存在但没有 writeText：回传 false，不误报成功", async () => {
    stubClipboard({ write: async () => {} });
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  // 权限被拒 / 窗口失焦 / 非安全上下文下的原生拒绝都走这条：promise 被拒。
  test("writeText 返回 rejected promise：回传 false", async () => {
    stubClipboard({ writeText: () => Promise.reject(new Error("NotAllowedError")) });
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  test("writeText 同步抛错：回传 false 而不是把异常抛给调用方", async () => {
    stubClipboard({
      writeText: () => {
        throw new Error("boom");
      },
    });
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  // 契约守护：机制里不许长出 UI / i18n / 自己的降级实现。扫的是运行时代码，注释里的「为什么不做」不算。
  test("模块不依赖 toast / i18n / React，也不自带 execCommand 降级", () => {
    const source = readFileSync(join(import.meta.dir, "..", "lib", "clipboard.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    for (const forbidden of ["sonner", "react-i18next", "react", "execCommand", "document"]) {
      expect(code.includes(forbidden), `原语的运行时代码里不应出现 ${forbidden}`).toBe(false);
    }
  });
});
