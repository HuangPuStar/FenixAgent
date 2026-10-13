import { afterEach, describe, expect, test } from "bun:test";
import { getAgentConfigById } from "../server/system-entries";
import { installAgentModuleStub, resetAgentModuleStub, scopedAgent } from "./fixtures";

/**
 * `getAgentConfigById(id, organizationId)` 的归属收窄。
 *
 * 这条入口服务的是「手上只有配置 ID + 当前组织」的系统流程：machine 的文件路径按环境绑定的配置解析执行
 * 节点、站点绑定校验配置是否属于本站点所属组织。归属判定因此被做成**入口参数**而不是「读完之后调用方自己
 * 比一下 `organizationId`」——前者每一条调用都拿同一个谓词，后者漏比一次就是一次跨组织读。
 *
 * 与 `getAgentConfigVisibleToUser` 的分工：那条按真实用户身份走授权谓词（成员关系决定可见性），本条的
 * organizationId 是**等值归属**约束，用于已由环境 / 站点校验过主体、只需确认资源归属的场景。
 */
describe("getAgentConfigById 的归属收窄", () => {
  afterEach(() => resetAgentModuleStub());

  // 同组织读到行：machine 的文件路径据此解析执行节点，读不到才会退回默认机器或本地 FS。
  test("组织匹配时返回该行", async () => {
    installAgentModuleStub({
      service: { findRowUnscoped: async () => scopedAgent({ organizationId: "org-1" }) },
    });

    await expect(getAgentConfigById("agent-1", "org-1")).resolves.toEqual(
      expect.objectContaining({ id: "agent-1", organizationId: "org-1" }),
    );
  });

  // 跨组织读不到（§10.3 多租户隔离）：环境属于 org-2 却绑定了 org-1 的配置时，调用方必须读不到行，
  // 否则机器文件路径会按别的组织声明的执行节点路由用户的文件请求。
  test("跨组织时返回 null", async () => {
    installAgentModuleStub({
      service: { findRowUnscoped: async () => scopedAgent({ organizationId: "org-1" }) },
    });

    await expect(getAgentConfigById("agent-1", "org-2")).resolves.toBeNull();
  });
});
