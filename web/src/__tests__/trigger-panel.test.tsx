import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webSrc = join(import.meta.dirname, "..");

describe("TriggerPanel", () => {
  const src = readFileSync(join(webSrc, "pages/workflow/components/TriggerPanel.tsx"), "utf-8");

  // 测试组件使用 i18n
  test("component uses i18n for user-visible text", () => {
    expect(src).toContain('useTranslation("workflows")');
    expect(src).toContain('t("editor.trigger_title")');
    expect(src).toContain('t("editor.trigger_create")');
    expect(src).toContain('t("editor.trigger_empty")');
  });

  // 测试组件使用 SDK API
  test("component uses workflowDefApi for trigger CRUD", () => {
    expect(src).toContain("workflowDefApi");
    expect(src).toContain("workflowDefApi.listTriggers");
    expect(src).toContain("workflowDefApi.createTrigger");
    expect(src).toContain("workflowDefApi.deleteTrigger");
    expect(src).toContain("workflowDefApi.regenerateTriggerHash");
    expect(src).toContain("workflowDefApi.enableTrigger");
    expect(src).toContain("workflowDefApi.disableTrigger");
  });

  // 测试无硬编码中文/英文字符串
  test("no hardcoded user-visible strings", () => {
    // 不应出现未包裹 t() 的中文
    const chinesePattern = /[\u4e00-\u9fff]/;
    const lines = src.split("\n");
    for (const line of lines) {
      if (line.includes("//") || line.includes("console.")) continue;
      if (chinesePattern.test(line)) {
        expect(line).toContain("t(");
      }
    }
  });
});

describe("WorkflowEditor trigger integration", () => {
  const src = readFileSync(join(webSrc, "pages/workflow/WorkflowEditor.tsx"), "utf-8");

  // 测试 editor 导入了 TriggerPanel
  test("editor imports TriggerPanel component", () => {
    expect(src).toContain('import { TriggerPanel }');
    expect(src).toContain('./components/TriggerPanel');
  });

  // 测试 editor 包含 triggers tab 类型
  test("editor includes triggers in rightTab type", () => {
    expect(src).toContain('"triggers"');
  });

  // 测试 editor 包含 triggers tab header
  test("editor includes triggers tab header", () => {
    expect(src).toContain('t("editor.tab_triggers")');
  });

  // 测试 editor 渲染 TriggerPanel
  test("editor renders TriggerPanel component", () => {
    expect(src).toContain("<TriggerPanel");
  });
});

describe("Trigger i18n keys", () => {
  const enSrc = readFileSync(join(webSrc, "i18n/locales/en/workflows.json"), "utf-8");
  const zhSrc = readFileSync(join(webSrc, "i18n/locales/zh/workflows.json"), "utf-8");
  const en = JSON.parse(enSrc);
  const zh = JSON.parse(zhSrc);

  // 测试中英文都有 trigger 相关 key
  test("both locales have trigger keys", () => {
    const triggerKeys = [
      "tab_triggers",
      "trigger_title",
      "trigger_create",
      "trigger_creating",
      "trigger_empty",
      "trigger_empty_hint",
      "trigger_url_label",
      "trigger_copy",
      "trigger_copied",
      "trigger_regenerate",
      "trigger_regenerate_confirm",
      "trigger_delete",
      "trigger_delete_confirm",
      "trigger_enabled",
      "trigger_disabled",
      "trigger_created",
      "trigger_deleted",
      "trigger_hash_regenerated",
      "trigger_enabled_ok",
      "trigger_disabled_ok",
      "trigger_load_failed",
      "trigger_create_failed",
      "trigger_delete_failed",
      "trigger_regenerate_failed",
      "trigger_type_webhook",
    ];

    for (const key of triggerKeys) {
      expect(en.editor[key], `en missing editor.${key}`).toBeDefined();
      expect(zh.editor[key], `zh missing editor.${key}`).toBeDefined();
    }
  });
});
