// web/src/__tests__/admin-observer-utils.test.ts
// Observer 面板纯函数单测：平坦表合并去重、machine 拓扑反查、integrity 归纳。
// 只测关键数据流，不做 UI 结构断言（CLAUDE.md 前端测试规范）。

import { describe, expect, test } from "bun:test";
import type { AcpLinkSnapshot } from "../api/observer";
import { integrityRows, machineReverseIndex, mergeFlatRows, name } from "../pages/admin/utils";

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
});
