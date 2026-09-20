/**
 * 删除 Agent 前的运行实例清理：包内可覆盖的边界与接缝说明（C-R1 修复验证，S4 接缝迁移）。
 *
 * 背景：删除 `agent_config` 只删 DB 行，其绑定 environment 上正在运行的编排实例（Agent 进程 +
 * controller 活跃表 + registry supplement + 并发额度）会残留为资源泄漏，idle monitor 对 interactive
 * 实例永不回收（见 docs/issues/2026-08-19-agent-delete-instance-leak.md）。修复后删除路径在 DB 事务前
 * 主动停止实例，编排收敛在 `AgentConfigFacade.remove`（授权 → 收集绑定 env → 停实例 → 删行），因此本
 * 文件用**真实 Facade** + 领域服务替身驱动：停实例是 Facade 自身的行为，换成 Facade 替身就没有覆盖了。
 *
 * 覆盖边界（为什么这里只有「无绑定 Environment」这一条）：
 * 走清理链路的用例必须给 `orchestration-instance` 内的 `getCoreRuntime()` 注入替身，而该函数直接读宿主
 * `@server/services/core-bootstrap`，唯一接缝是宿主的 `stubCoreBootstrap`。1.3 静态条件 1 与评审 §6.2
 * 判定该替身按归属迁入 **agent-runtime** 的 `/server/testing`（该入口尚未就绪），且包内不得 import
 * `@server/**`——两者叠加使「有绑定环境」的路径在当前包内不可测。
 * 因此本文件只覆盖不进入清理链路的分支：无绑定 Environment 时删除照常成功、授权仍先行于清理。
 * 清理链路本体（registry/core/controller 三侧收集、单点失败不中断、跨组织隔离）已有 agent-runtime
 * 包内覆盖：packages/agent-runtime/src/__tests__/orchestration-instance-cleanup-isolation.test.ts。
 * Facade 接线（按组织传参、清理失败仍删除）的用例随 agent-runtime `/server/testing` 就绪后恢复，已登记
 * 在 sharedPatches / openIssues。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ForbiddenError } from "@fenix/platform-sdk";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { agentConfigResource } from "../server/access/agent-config-resource";
import { AgentConfigFacade } from "../server/facades/agent-config-facade";
import { createStubAgentConfigService, initializeAgentConfigModuleConfig } from "../server/testing";
import { createFakeAccessControl, createRecordingScopeStore, denied, scopedAgent, testActor } from "./fixtures";

const ORG_1 = "org-1";
const AGENT_ID = "agc_1";
const AGENT_NAME = "demo-agent";

/** 删除路径最终落到领域服务 `remove` 的入参；非空即代表 DB 删除步骤被执行。 */
let removedInputs: Array<{ resourceId: string; organizationId: string }> = [];

/** 装配真实 Facade：授权替身表达权限结论，领域服务替身表达「Agent 存在 + 绑定这些 env + 删除成功」。 */
async function removeAgentConfig(envIds: string[], accessControl = createFakeAccessControl()): Promise<void> {
  const { store } = createRecordingScopeStore();
  const facade = new AgentConfigFacade(
    createStubAgentConfigService({
      findByName: async ({ name }) => scopedAgent({ id: AGENT_ID, organizationId: ORG_1, name }),
      listBoundEnvironmentIds: async () => envIds,
      remove: async (input) => {
        removedInputs.push(input);
        return true;
      },
    }),
    {
      accessControl,
      resource: agentConfigResource.definition,
      scopeStore: store,
    },
  );
  await facade.remove(testActor(), AGENT_NAME);
}

describe("deleteAgentConfig 的运行实例清理边界", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
    removedInputs = [];
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 无绑定 Environment 时删除照常成功：清理链路只对有绑定环境的分支生效，删行仍按授权后的归属入参执行。
  test("无绑定 Environment 时删除成功且不进入清理链路", async () => {
    await removeAgentConfig([]);

    expect(removedInputs).toEqual([{ resourceId: AGENT_ID, organizationId: ORG_1 }]);
  });

  // 授权先于清理与删行：delete 动作被拒时抛 403，领域服务一步都不执行——否则会出现「未授权却已停实例」。
  test("delete 动作被拒时抛 ForbiddenError 且不执行删除", async () => {
    const accessControl = createFakeAccessControl({
      authorize: async ({ action }) => {
        if (action === "delete") denied();
      },
    });

    await expect(removeAgentConfig([], accessControl)).rejects.toBeInstanceOf(ForbiddenError);
    expect(removedInputs).toEqual([]);
  });
});
