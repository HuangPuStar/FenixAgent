import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dirname, "..");
const src = fs.readFileSync(join(srcDir, "pages/Dashboard.tsx"), "utf-8");

describe("Dashboard.tsx i18n Chinese translations", () => {
  test('source does not contain English title "Agents"', () => {
    expect(src).not.toContain(">Agents<");
  });

  test('source does not contain English title "Sessions"', () => {
    expect(src).not.toContain(">Sessions<");
  });

  test('source does not contain English title "Active"', () => {
    expect(src).not.toContain(">Active<");
  });

  test('source contains Chinese title "智能体"', () => {
    expect(src).toContain("智能体");
  });

  test('source contains Chinese loading text', () => {
    expect(src).toContain("加载系统概览");
  });
});
