// Channel 包的移除回归：Hermes 通道实现（Hermes 客户端、ACP 事件桥、通道绑定路由与页面）已删除，
// 包内只保留 IM 通道的表定义与模块描述符。这条用例把「移除后应当仍然成立」的两件事钉住：
// 目标表仍在、旧绑定表与它那套对外面不再回来。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@fenix/resource-channel/db";
import { moduleManifest } from "@fenix/resource-channel/module";
import { getTableName } from "drizzle-orm";

const PKG_ROOT = join(import.meta.dir, "../..");

describe("Channel 包在移除 Hermes 后的交付面", () => {
  // IMChannel 的两张目标表必须继续由本包持有：它们的定义是后续通道能力重建的起点。
  test("继续导出 im_channel / im_channel_route 两张目标表", () => {
    expect(getTableName(schema.imChannel)).toBe("im_channel");
    expect(getTableName(schema.imChannelRoute)).toBe("im_channel_route");
  });

  // channel_binding 已由 drop 迁移删除；表对象或 DDL 若重新出现，说明移除被回退。
  test("不再导出也不再定义 channel_binding 表", () => {
    expect(Object.keys(schema)).not.toContain("channelBinding");
    expect(readFileSync(join(PKG_ROOT, "db/schema.ts"), "utf8")).not.toMatch(/pgTable\(\s*"channel_binding"/);
  });

  // 对外面只剩表定义与模块描述符：server / web 出口随 Hermes 实现一起删除，重建时再按需新增。
  test("package.json 只保留根、db 与 module 三个出口", () => {
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([".", "./db", "./module"]);
  });

  // 模块描述符不得残留 Hermes 时代的装配声明（网关环境变量、路由贡献、运行期工厂）。
  test("模块描述符不再声明 envDefinitions / contributions / create", () => {
    expect(moduleManifest).toMatchObject({
      id: "channel",
      kind: "resource",
      dependsOn: [],
      capabilities: ["resource.channel"],
    });
    expect("envDefinitions" in moduleManifest).toBe(false);
    expect("contributions" in moduleManifest).toBe(false);
    expect("create" in moduleManifest).toBe(false);
    expect("web" in moduleManifest).toBe(false);
  });
});
