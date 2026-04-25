import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";

const appShell = fs.readFileSync("src/components/shell/AppShell.tsx", "utf-8");
const envList = fs.readFileSync("src/components/EnvironmentList.tsx", "utf-8");
const sessionList = fs.readFileSync("src/components/SessionList.tsx", "utf-8");

describe("AppShell.tsx i18n", () => {
  test('contains "退出登录"', () => {
    expect(appShell).toContain("退出登录");
  });

  test('contains brand "AI Panel"', () => {
    expect(appShell).toContain("AI Panel");
  });
});

describe("EnvironmentList.tsx i18n", () => {
  test('does not contain "No active environments"', () => {
    expect(envList).not.toContain("No active environments");
  });

  test('contains "暂无活跃环境"', () => {
    expect(envList).toContain("暂无活跃环境");
  });

  test('preserves proper noun "ACP Agent"', () => {
    expect(envList).toContain('"ACP Agent"');
  });

  test('preserves proper noun "Claude Code"', () => {
    expect(envList).toContain('"Claude Code"');
  });
});

describe("SessionList.tsx i18n", () => {
  test('does not contain "No sessions yet"', () => {
    expect(sessionList).not.toContain("No sessions yet");
  });

  test('contains "暂无会话"', () => {
    expect(sessionList).toContain("暂无会话");
  });
});
