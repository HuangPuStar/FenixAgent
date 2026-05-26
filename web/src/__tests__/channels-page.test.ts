import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dirname, "..");

describe("ChannelsPage", () => {
  // 测试页面使用 i18n
  test("page source uses i18n for channel copy", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain('useTranslation("channels")');
    expect(src).toContain('t("title")');
    expect(src).toContain('t("newBinding")');
  });

  // 测试页面使用 SDK 模块
  test("page source uses SDK for channel APIs", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("channelApi");
  });

  // 测试页面包含绑定管理 UI
  test("page source contains binding management UI", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("DataTable<ChannelBinding>");
    expect(src).toContain('t("table.emptyMessage")');
    expect(src).toContain('t("actions.delete")');
    expect(src).not.toContain("Provider 状态");
    expect(src).not.toContain("已接入通道");
  });
});
