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
    // 关闭按钮是纯图标按钮，可访问名只能由 aria-label 提供——面板头共享件的 closeLabel 必须接上词条
    expect(src).toContain('closeLabel={t("editor.trigger_panel_close")}');
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
    // 不应出现未包裹 t() 的中文。
    // `/** … */` 块注释里的中文是给维护者看的（既有实现只用 `//` 行注释，本批起两种注释都会用），
    // 逐行筛 '//' 会把块注释正文当成用户可见文案，故这里显式跟踪块注释区间——守卫的意图是
    // 「界面上的文案必须走 t()」，注释不在此列。
    const chinesePattern = /[\u4e00-\u9fff]/;
    const lines = src.split("\n");
    let inBlockComment = false;
    for (const line of lines) {
      const trimmed = line.trim();
      const wasInBlockComment = inBlockComment;
      if (inBlockComment && trimmed.includes("*/")) inBlockComment = false;
      else if (!inBlockComment && trimmed.startsWith("/*")) inBlockComment = !trimmed.includes("*/");
      if (wasInBlockComment || line.includes("//") || line.includes("console.")) continue;
      if (chinesePattern.test(line)) {
        expect(line).toContain("t(");
      }
    }
  });
});

describe("WorkflowEditor trigger integration", () => {
  // 2026-09-23：触发器 Sheet 随 `WorkflowEditor.tsx` 的拆分移到了浮层模块（编辑器只传开关与 id），
  // 断言的两个载体仍要同时成立——浮层模块引 `TriggerPanel`，编辑器把开关交给它。少任何一侧都说明
  // 「编辑器保留触发器入口」这件事没落地。
  const editorSrc = readFileSync(join(webSrc, "pages/workflow/WorkflowEditor.tsx"), "utf-8");
  const overlaysSrc = readFileSync(join(webSrc, "pages/workflow/components/workflow-editor-overlays.tsx"), "utf-8");

  // 测试浮层模块导入了 TriggerPanel
  test("editor overlays import TriggerPanel component", () => {
    expect(overlaysSrc).toContain("import { TriggerPanel }");
    expect(overlaysSrc).toContain("./TriggerPanel");
  });

  // triggers 按钮已从 toolbar 移除，Sheet/TriggerPanel 组件仍保留
  test("editor retains triggers sheet and TriggerPanel", () => {
    expect(overlaysSrc).toContain("triggersSheetOpen");
    expect(overlaysSrc).toContain("<TriggerPanel");
    expect(editorSrc).toContain("triggersSheetOpen={triggersSheetOpen}");
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
      "trigger_panel_close",
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
