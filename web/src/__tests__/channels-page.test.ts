import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const webRoot = join(import.meta.dirname, "..");

describe("ChannelsPage", () => {
  test("page source contains required Chinese copy", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("消息渠道");
    expect(src).toContain("新建消息渠道");
    expect(src).toContain("搜索消息渠道...");
    expect(src).toContain("暂不支持");
  });

  test("page source uses channel api functions", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("apiListChannelProviders");
    expect(src).toContain("apiListChannels");
  });

  test("page source contains abstract-layer guidance and empty state", () => {
    const src = readFileSync(join(webRoot, "pages/ChannelsPage.tsx"), "utf-8");
    expect(src).toContain("DataTable<ChannelInfo>");
    expect(src).toContain('emptyMessage="暂无数据"');
    expect(src).toContain("编辑");
    expect(src).toContain("删除");
    expect(src).not.toContain("Provider 状态");
    expect(src).not.toContain("已接入通道");
  });
});
