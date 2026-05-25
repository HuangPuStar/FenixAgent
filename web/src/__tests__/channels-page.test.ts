import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dirname, "..");

describe("ChannelsPage", () => {
  // 测试页面包含中文文案
  test("page source contains required Chinese copy", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("消息渠道");
    expect(src).toContain("新建绑定");
    expect(src).toContain("搜索绑定...");
  });

  // 测试页面使用 Eden Treaty client
  test("page source uses Eden Treaty client for channel APIs", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("client.web.channels");
  });

  // 测试页面包含绑定管理 UI
  test("page source contains binding management UI", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("DataTable<ChannelBinding>");
    expect(src).toContain("暂无绑定");
    expect(src).toContain("删除");
    expect(src).not.toContain("Provider 状态");
    expect(src).not.toContain("已接入通道");
  });
});
