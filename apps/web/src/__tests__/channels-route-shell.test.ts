// 消息通道页的路由壳与导航贡献契约。
//
// 导航项 `id` 同时是路由目标（Shell 拼成 `/agent/channels`），而导航由包声明、路由壳由宿主建。
// `shell-navigation-routes.test.ts` 只保证「id 能在路由表里找到」；这条用例补上两点：壳必须懒加载
// **包**的页面（而不是把页面抄进宿主），以及贡献里的分组 / 顺序 / 文案键保持规格 §7.1 的声明。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CHANNELS_NS, channelsResources } from "@fenix/resource-channel/web/i18n";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import { routeTree } from "../routeTree.gen";

const WEB_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const ROUTE_SOURCE = readFileSync(join(WEB_ROOT, "routes/agent/_panel/channels.tsx"), "utf8");
const CONTRIBUTION_SOURCE = readFileSync(join(REPO_ROOT, "packages/resources/channel/web/contribution.ts"), "utf8");

const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/agent/channels"] }),
  isServer: true,
});

describe("消息通道页的路由壳", () => {
  // 业务意图：导航项点下去必须落到真实路由；id 与文件名不一致时装配期不报错，用户只会看到空白页。
  test("路由表里有 /agent/channels", () => {
    expect("/agent/channels" in router.routesByPath).toBe(true);
  });

  // 业务意图：页面归属包，宿主只留懒加载壳；把实现复制进宿主会让两个工作区的消息通道页各演化一份。
  test("壳懒加载包的浏览器出口并挂到 AgentChannelsPage", () => {
    expect(ROUTE_SOURCE).toContain('import("@fenix/resource-channel/web")');
    expect(ROUTE_SOURCE).toContain("m.AgentChannelsPage");
  });
});

describe("消息通道的导航贡献", () => {
  // 业务意图：分组与组内位置是用户可见契约（config 组、tasks 之后 memories 之前），漂移会让侧栏乱序。
  test("声明 channels 导航项、config 分组与 65 的组内顺序", () => {
    expect(CONTRIBUTION_SOURCE).toContain('id: "channels"');
    expect(CONTRIBUTION_SOURCE).toContain('groupId: "config"');
    expect(CONTRIBUTION_SOURCE).toContain("order: 65");
  });

  // 业务意图：文案键与命名空间要和包字典同源，否则侧栏项会回显成 `langbot.nav.channels` 原文。
  test("导航文案在包字典里存在", () => {
    expect(CONTRIBUTION_SOURCE).toContain("CHANNELS_NS");
    expect(channelsResources.en.langbot.nav.channels.length).toBeGreaterThan(0);
    expect(channelsResources.zh.langbot.nav.channels.length).toBeGreaterThan(0);
    expect(CHANNELS_NS).toBe("channels");
  });
});
