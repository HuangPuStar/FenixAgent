import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("i18n bootstrap import", () => {
  // 锁定 subpath import，避免 CI/Bun 对 react-i18next 根入口 named export 解析不稳定
  test("web i18n bootstrap uses initReactI18next subpath import", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "i18n", "index.ts"), "utf-8");
    expect(src).toContain('from "react-i18next/initReactI18next"');
  });
});
