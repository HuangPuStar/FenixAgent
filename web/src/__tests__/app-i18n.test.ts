import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dirname, "..");
const appSrc = fs.readFileSync(join(webRoot, "App.tsx"), "utf-8");
const sidebarSrc = fs.readFileSync(join(webRoot, "components/shell/Sidebar.tsx"), "utf-8");

describe("App.tsx i18n Chinese translations", () => {
    test('source does not contain English label "Loading..."', () => {
        expect(appSrc).not.toContain('"Loading..."');
    });

    test('source contains loading text', () => {
        expect(appSrc).toContain("加载中...");
    });

    test('Sidebar contains Chinese label "智能体"', () => {
        expect(sidebarSrc).toContain('label: "智能体"');
    });

    test('Sidebar contains Chinese label "模型"', () => {
        expect(sidebarSrc).toContain('label: "模型"');
    });

    test('Sidebar contains Chinese label "技能"', () => {
        expect(sidebarSrc).toContain('label: "技能"');
    });

    test('Sidebar contains "API Key" label', () => {
        expect(sidebarSrc).toContain('label: "API Key"');
    });

    test('App source contains "智能体" at least once', () => {
        const combined = appSrc + sidebarSrc;
        const matches = combined.match(/智能体/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(1);
    });
});
