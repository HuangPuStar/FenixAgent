// Channel 包的交付面回归：Hermes 通道实现已删除，包内保留 IM 通道表定义、模块描述符与服务端控制面。
// 这条用例钉住三件事：目标表仍在、旧绑定表不再回来、控制面的对外出口与部署声明是可预期的。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@fenix/resource-channel/db";
import { moduleManifest } from "@fenix/resource-channel/module";
import { getTableName } from "drizzle-orm";

const PKG_ROOT = join(import.meta.dir, "../..");

describe("Channel 包的交付面", () => {
  // IMChannel 的两张目标表必须继续由本包持有：它们的定义是通道能力的起点。
  test("继续导出 im_channel / im_channel_route 两张目标表", () => {
    expect(getTableName(schema.imChannel)).toBe("im_channel");
    expect(getTableName(schema.imChannelRoute)).toBe("im_channel_route");
  });

  // channel_binding 已由 drop 迁移删除；表对象或 DDL 若重新出现，说明移除被回退。
  test("不再导出也不再定义 channel_binding 表", () => {
    expect(Object.keys(schema)).not.toContain("channelBinding");
    expect(readFileSync(join(PKG_ROOT, "db/schema.ts"), "utf8")).not.toMatch(/pgTable\(\s*"channel_binding"/);
  });

  // 对外面 = 根、db、module、server 四个服务端出口 + 浏览器面的页面入口、路由壳贡献、字典与纯逻辑模块。
  // 浏览器面单独开窄出口，避免宿主登记字典时把页面图拉进首屏。
  test("package.json 出口覆盖服务端面与浏览器面", () => {
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([
      ".",
      "./db",
      "./module",
      "./server",
      "./web",
      "./web/contribution",
      "./web/i18n",
      "./web/lib/channel-page-state",
    ]);
  });

  // 模块必须以资源模块身份装配控制面、数据面入站与 MCP 入口，并把 LangBot 配置声明在自己名下（宿主 env 不得有同名键）。
  test("模块描述符声明控制面、数据面与 MCP 路由以及 LangBot 环境变量", () => {
    expect(moduleManifest).toMatchObject({
      id: "channel",
      kind: "resource",
      dependsOn: [],
      capabilities: ["resource.channel"],
    });
    expect(moduleManifest.contributions?.map((item) => item.id)).toEqual([
      "channel.web-langbot",
      "channel.hooks-langbot",
      "channel.mcp-im",
      "channel.api-system-channels",
    ]);
    expect(moduleManifest.contributions?.map((item) => item.slot)).toEqual(["web", "app", "app", "api"]);
    expect(moduleManifest.web).toEqual({
      id: "channel",
      contribution: "@fenix/resource-channel/web/contribution",
    });
    expect(moduleManifest.envDefinitions?.map((item) => item.key).sort()).toEqual([
      "IM_EVENT_TEXT_TTL_HOURS",
      "IM_TOKEN_SECRET",
      "LANGBOT_API_KEY",
      "LANGBOT_BASE_URL",
    ]);
    expect(moduleManifest.create).toBeFunction();
  });

  // 密钥必须在内核声明层就被标记为 secret：日志与部署清单据此决定是否展示值。
  test("LangBot API Key 与 IM token 密钥标记为 secret", () => {
    const secrets = (moduleManifest.envDefinitions ?? [])
      .filter((item) => item.secret)
      .map((item) => item.key)
      .sort();
    expect(secrets).toEqual(["IM_TOKEN_SECRET", "LANGBOT_API_KEY"]);
  });
});
