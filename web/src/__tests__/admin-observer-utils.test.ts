// web/src/__tests__/admin-observer-utils.test.ts
// Observer 面板纯函数单测：平坦表合并去重、machine 拓扑反查、integrity 归纳。
// 只测关键数据流，不做 UI 结构断言（CLAUDE.md 前端测试规范）。

import { describe, expect, test } from "bun:test";
import type { AcpLinkSnapshot } from "../api/observer";
import {
  chatRelayPayload,
  formatDuration,
  groupYjsSessions,
  integrityRows,
  machineReverseIndex,
  mergeFlatRows,
  name,
  sessionTabCounts,
} from "../pages/admin/utils";

/** 构造一致的 acp-link 观察视图 fixture（byOrg + byEntity 交叉覆盖去重场景）。 */
function makeView(): AcpLinkSnapshot {
  return {
    generatedAt: "2026-08-19T00:00:00.000Z",
    kind: "acp-link",
    total: 4,
    trees: {
      byEntity: [
        {
          machineId: "mach_1",
          count: 2,
          leaves: [
            { id: "external-relay:r1", source: "external-relay", roleId: "mach_1" },
            { id: "acp-ws:ws_m1", source: "acp-ws", roleId: "mach_1" },
          ],
        },
        {
          machineId: "mach_2",
          count: 1,
          leaves: [{ id: "chat-relay:yjs_1", source: "chat-relay", roleId: "mach_2" }],
        },
      ],
      byOrg: [
        {
          organizationId: "org-1",
          userCount: 1,
          agentCount: 1,
          instanceCount: 1,
          leafCount: 3,
          children: [
            {
              userId: "user-1",
              agentCount: 1,
              leafCount: 3,
              children: [
                {
                  agentConfigId: "acfg-1",
                  instanceCount: 1,
                  leafCount: 2,
                  children: [
                    {
                      instanceId: "inst-1",
                      leafCount: 1,
                      leaves: [
                        {
                          id: "external-relay:r1",
                          source: "external-relay",
                          machineId: "mach_1",
                          payload: { source: "external-relay", openTime: 1000 },
                        },
                      ],
                    },
                  ],
                  leaves: [
                    {
                      id: "acp-ws:ws_l1",
                      source: "acp-ws",
                      machineId: null,
                      payload: { source: "acp-ws", openTime: 2000 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    integrity: { checked: 4, mismatched: 1, mismatchedItems: [{ kind: "acp-link", id: "acp-ws:ws_m1" }] },
    names: {
      organizationId: { "org-1": "Acme 组织" },
      userId: { "user-1": "张三" },
      agentConfigId: { "acfg-1": "客服助手" },
      instanceId: { "inst-1": "生产环境 #2" },
      machineId: { mach_1: "边缘节点-01", mach_2: "边缘节点-02" },
    },
  };
}

describe("admin observer utils", () => {
  // 平坦表按 id 去重：跨树出现的叶子合并为一行，byOrg 侧上下文与 openTime 应保留。
  test("mergeFlatRows 合并 byOrg/byEntity 叶子并按 id 去重", () => {
    const rows = mergeFlatRows(makeView());
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.id)).toEqual([
      "acp-ws:ws_l1",
      "acp-ws:ws_m1",
      "chat-relay:yjs_1",
      "external-relay:r1",
    ]);

    // 双树共有的叶子：byOrg 上下文 + payload openTime 保留
    const relay = rows.find((row) => row.id === "external-relay:r1")!;
    expect(relay.organizationId).toBe("org-1");
    expect(relay.userId).toBe("user-1");
    expect(relay.agentConfigId).toBe("acfg-1");
    expect(relay.instanceId).toBe("inst-1");
    expect(relay.machineId).toBe("mach_1");
    expect(relay.openTime).toBe(1000);

    // 仅 machine 树的叶子（无 org）：machineId 来自 byEntity 的 roleId
    const machine = rows.find((row) => row.id === "acp-ws:ws_m1")!;
    expect(machine.machineId).toBe("mach_1");
    expect(machine.organizationId).toBeNull();

    // 仅 byOrg 的 agent 级叶子：无 instanceId，machineId 为 null
    const local = rows.find((row) => row.id === "acp-ws:ws_l1")!;
    expect(local.instanceId).toBeNull();
    expect(local.machineId).toBeNull();
    expect(local.openTime).toBe(2000);
  });

  // machine 反查索引：machineId → 其承载的全部 leaf id（两树合并、去重）。
  test("machineReverseIndex 建立 machineId → leafId 索引", () => {
    const index = machineReverseIndex(makeView());
    expect(index.get("mach_1")).toEqual(["external-relay:r1", "acp-ws:ws_m1"]);
    expect(index.get("mach_2")).toEqual(["chat-relay:yjs_1"]);
    // machineId 为 null 的叶子不进索引
    expect(index.has("null")).toBe(false);
    expect(index.size).toBe(2);
  });

  // integrity 归纳：mismatchedItems 直出展示行（仅 kind+id）。
  test("integrityRows 归纳不一致明细", () => {
    const rows = integrityRows(makeView());
    expect(rows).toEqual([{ kind: "acp-link", id: "acp-ws:ws_m1" }]);
  });

  // name(id)：命中字典返回可读名称，未命中回退原始 id，无值返回空串。
  test("name 解析角色名称与回退", () => {
    const view = makeView();
    expect(name(view.names, "organizationId", "org-1")).toBe("Acme 组织");
    expect(name(view.names, "instanceId", "inst-1")).toBe("生产环境 #2");
    // 字典未命中的 id 回退显示原始 id
    expect(name(view.names, "userId", "user-999")).toBe("user-999");
    // 无角色值时返回空串（调用方展示占位符）
    expect(name(view.names, "machineId", null)).toBe("");
  });

  // chat-relay payload 收窄：仅 chat-relay 且有 payload 才返回概要，字段逐项类型收窄。
  test("chatRelayPayload 只收窄 chat-relay 叶子", () => {
    const relay = {
      id: "c1",
      source: "chat-relay",
      machineId: null,
      payload: { openTime: 5000, rcsSessionId: "rcs_1" },
    };
    expect(chatRelayPayload(relay)).toEqual({ openTime: 5000, rcsSessionId: "rcs_1" });
    // 非 chat-relay 来源返回 null
    expect(chatRelayPayload({ id: "a1", source: "acp-ws", machineId: null })).toBeNull();
    // chat-relay 但 payload 字段类型不匹配时只保留合法字段
    expect(
      chatRelayPayload({
        id: "c2",
        source: "chat-relay",
        machineId: null,
        payload: { openTime: "bad", acpSessionId: "ses_1" },
      }),
    ).toEqual({ acpSessionId: "ses_1" });
  });

  // 时长粒度：按秒/分/小时/天逐级归一化，供 i18n 单位文案渲染。
  test("formatDuration 归一化时长粒度", () => {
    expect(formatDuration(45_000)).toEqual({ value: 45, unit: "second" });
    expect(formatDuration(5 * 60 * 1000 + 4000)).toEqual({ value: 5, unit: "minute" });
    expect(formatDuration(3 * 3600 * 1000 + 5000)).toEqual({ value: 3, unit: "hour" });
    expect(formatDuration(50 * 3600 * 1000)).toEqual({ value: 2, unit: "day" });
  });

  // 同会话标签页计数：按 rcsSessionId 分组统计 chat-relay 叶子，非 chat-relay/无会话不计。
  test("sessionTabCounts 统计同会话多标签页", () => {
    const orgs = [
      {
        organizationId: "org-1",
        userCount: 1,
        agentCount: 1,
        instanceCount: 1,
        leafCount: 3,
        children: [
          {
            userId: "user-1",
            agentCount: 1,
            leafCount: 3,
            children: [
              {
                agentConfigId: "acfg-1",
                instanceCount: 1,
                leafCount: 3,
                children: [
                  {
                    instanceId: "inst-1",
                    leafCount: 2,
                    leaves: [
                      { id: "c1", source: "chat-relay", machineId: null, payload: { rcsSessionId: "rcs_x" } },
                      { id: "c2", source: "chat-relay", machineId: null, payload: { rcsSessionId: "rcs_x" } },
                      { id: "c3", source: "chat-relay", machineId: null, payload: { rcsSessionId: "rcs_y" } },
                    ],
                  },
                ],
                leaves: [{ id: "a1", source: "acp-ws", machineId: null, payload: { rcsSessionId: "rcs_x" } }],
              },
            ],
          },
        ],
      },
    ] as AcpLinkSnapshot["trees"]["byOrg"];
    const counts = sessionTabCounts(orgs);
    expect(counts.get("rcs_x")).toBe(2);
    expect(counts.get("rcs_y")).toBe(1);
    expect(counts.size).toBe(2);
  });

  // Y.Doc 会话分组：chat-relay 链接按 rcsSessionId 归入会话，无会话链接留在 ungrouped。
  test("groupYjsSessions 按 rcsSessionId 分组出会话层", () => {
    const leaves = [
      { id: "c1", source: "chat-relay", machineId: null, payload: { rcsSessionId: "rcs_b" } },
      { id: "a1", source: "acp-ws", machineId: null, payload: { openTime: 1000 } },
      { id: "c2", source: "chat-relay", machineId: null, payload: { rcsSessionId: "rcs_a" } },
      { id: "c3", source: "chat-relay", machineId: null, payload: { rcsSessionId: "rcs_a" } },
    ];
    const { sessions, ungrouped } = groupYjsSessions(leaves);
    // 会话按 rcsSessionId 字典序稳定输出
    expect(sessions.map((s) => s.rcsSessionId)).toEqual(["rcs_a", "rcs_b"]);
    expect(sessions[0].leaves.map((l) => l.id)).toEqual(["c2", "c3"]);
    expect(sessions[1].leaves.map((l) => l.id)).toEqual(["c1"]);
    // 非 chat-relay 且无 rcsSessionId 的链接不进会话层
    expect(ungrouped.map((l) => l.id)).toEqual(["a1"]);
  });

  // 会话分组对空输入与全无会话输入保持稳定（不抛错、空数组）。
  test("groupYjsSessions 空输入返回空会话", () => {
    const { sessions, ungrouped } = groupYjsSessions([]);
    expect(sessions).toEqual([]);
    expect(ungrouped).toEqual([]);
    const onlyRelay = groupYjsSessions([{ id: "r1", source: "external-relay", machineId: null }]);
    expect(onlyRelay.sessions).toEqual([]);
    expect(onlyRelay.ungrouped.map((l) => l.id)).toEqual(["r1"]);
  });
});
