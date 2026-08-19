import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type AgentKnowledgeBindingInsert,
  agentKnowledgeBindingRepo,
  type KnowledgeBaseInsert,
  type KnowledgeResourceInsert,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../repositories/knowledge-base";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function selected<T>(rows: T[]) {
  const result = Promise.resolve(rows);
  const limited = Object.assign(result, { limit: () => result });
  const ordered = Object.assign(result, { limit: () => result });
  const filtered = Object.assign(result, { limit: () => limited, orderBy: () => ordered });
  return { from: () => ({ where: () => filtered }) };
}

function inserted<T>(row: T) {
  return { values: () => ({ returning: () => Promise.resolve([row]) }) };
}

function updated(onSet?: (data: unknown) => void) {
  return {
    set: (data: unknown) => ({
      where: () => {
        onSet?.(data);
        return Promise.resolve();
      },
    }),
  };
}

function deleted(rows: unknown[] = []) {
  return { where: () => ({ returning: () => Promise.resolve(rows) }) };
}

const baseInput: KnowledgeBaseInsert = {
  userId: "user-1",
  organizationId: "org-1",
  name: "产品文档",
  slug: "product-docs",
};
const resourceInput: KnowledgeResourceInsert = {
  knowledgeBaseId: "kb-1",
  sourceType: "file",
  sourceName: "guide.md",
};
const bindingInput: AgentKnowledgeBindingInsert = {
  agentConfigId: "agent-1",
  knowledgeBaseId: "kb-1",
};

beforeEach(resetAllStubs);

describe("round46 知识库仓储真实行为", () => {
  // 按 ID 查询应返回数据库首行。
  test("知识库按 ID 返回首个匹配项", async () => {
    stubDb({ select: () => selected([{ id: "kb-1" }, { id: "kb-2" }]) });
    expect(await knowledgeBaseRepo.getById("kb-1")).toEqual({ id: "kb-1" });
  });

  // 未命中知识库时必须归一为 null。
  test("知识库按 ID 未命中返回 null", async () => {
    stubDb({ select: () => selected([]) });
    expect(await knowledgeBaseRepo.getById("missing")).toBeNull();
  });

  // 用户与知识库联合查询不能把空结果泄露为 undefined。
  test("用户范围内查询缺失知识库返回 null", async () => {
    stubDb({ select: () => selected([]) });
    expect(await knowledgeBaseRepo.getByUserAndId("user-1", "foreign")).toBeNull();
  });

  // 用户列表应透传按更新时间排序后的全部行。
  test("用户知识库列表返回查询结果", async () => {
    const rows = [{ id: "new" }, { id: "old" }];
    stubDb({ select: () => selected(rows) });
    expect(await knowledgeBaseRepo.listByUserId("user-1")).toEqual(rows);
  });

  // 用户 slug 查询应支持命中首行。
  test("用户 slug 查询返回匹配知识库", async () => {
    stubDb({ select: () => selected([{ id: "kb-1", slug: "product-docs" }]) });
    expect(await knowledgeBaseRepo.findByUserAndSlug("user-1", "product-docs")).toEqual({
      id: "kb-1",
      slug: "product-docs",
    });
  });

  // 组织列表必须保留查询返回的所有知识库。
  test("组织知识库列表返回查询结果", async () => {
    stubDb({ select: () => selected([{ id: "kb-1" }]) });
    expect(await knowledgeBaseRepo.listByOrganizationId("org-1")).toEqual([{ id: "kb-1" }]);
  });

  // 组织与 ID 联合查询未命中时返回 null。
  test("组织范围内按 ID 未命中返回 null", async () => {
    stubDb({ select: () => selected([]) });
    expect(await knowledgeBaseRepo.getByOrgAndId("org-1", "foreign")).toBeNull();
  });

  // 可选用户过滤缺省时仍可查询组织 slug。
  test("组织 slug 查询允许省略用户过滤", async () => {
    stubDb({ select: () => selected([{ id: "shared" }]) });
    expect(await knowledgeBaseRepo.findByOrgAndSlug("org-1", "shared")).toEqual({ id: "shared" });
  });

  // 指定用户时组织 slug 查询应正常返回匹配行。
  test("组织 slug 查询支持额外用户过滤", async () => {
    stubDb({ select: () => selected([{ id: "owned", userId: "user-1" }]) });
    expect(await knowledgeBaseRepo.findByOrgAndSlug("org-1", "owned", "user-1")).toEqual({
      id: "owned",
      userId: "user-1",
    });
  });

  // 创建知识库应返回数据库 returning 行。
  test("创建知识库返回持久化行", async () => {
    const row = { id: "kb-created", ...baseInput };
    stubDb({ insert: () => inserted(row) });
    expect(await knowledgeBaseRepo.create(baseInput)).toEqual(row);
  });

  // 更新知识库应将调用方提供的字段交给更新链。
  test("更新知识库传递部分字段", async () => {
    let saved: unknown;
    stubDb({
      update: () =>
        updated((data) => {
          saved = data;
        }),
    });
    await knowledgeBaseRepo.update("kb-1", { name: "新名称", description: null });
    expect(saved).toEqual({ name: "新名称", description: null });
  });

  // 删除存在的知识库应报告成功。
  test("删除存在的知识库返回 true", async () => {
    stubDb({ delete: () => deleted([{ id: "kb-1" }]) });
    expect(await knowledgeBaseRepo.delete("kb-1")).toBeTrue();
  });

  // 删除未命中知识库应报告 false。
  test("删除缺失的知识库返回 false", async () => {
    stubDb({ delete: () => deleted() });
    expect(await knowledgeBaseRepo.delete("missing")).toBeFalse();
  });

  // 绑定统计缺少聚合行时使用零值。
  test("知识库绑定统计缺失时返回零", async () => {
    stubDb({ select: () => selected([]) });
    expect(await knowledgeBaseRepo.countBindings("kb-1")).toBe(0);
  });

  // 全局列表应返回排序查询的完整结果。
  test("全局知识库列表返回所有行", async () => {
    const rows = [{ id: "kb-2" }, { id: "kb-1" }];
    const result = Promise.resolve(rows);
    stubDb({ select: () => ({ from: () => ({ orderBy: () => result }) }) });
    expect(await knowledgeBaseRepo.listGlobal()).toEqual(rows);
  });

  // 数据库异常应原样传播给上层事务或错误处理器。
  test("知识库查询传播数据库异常", async () => {
    stubDb({
      select: () => {
        throw new Error("database unavailable");
      },
    });
    await expect(knowledgeBaseRepo.getById("kb-1")).rejects.toThrow("database unavailable");
  });

  // 资源按 ID 查询缺失时返回 null。
  test("资源按 ID 未命中返回 null", async () => {
    stubDb({ select: () => selected([]) });
    expect(await knowledgeResourceRepo.getById("missing")).toBeNull();
  });

  // 远端资源查询应返回首个匹配资源。
  test("资源按知识库和远端 ID 返回首行", async () => {
    stubDb({ select: () => selected([{ id: "resource-1", remoteId: "remote-1" }]) });
    expect(await knowledgeResourceRepo.getByRemoteId("kb-1", "remote-1")).toEqual({
      id: "resource-1",
      remoteId: "remote-1",
    });
  });

  // 源文件名查询未命中时返回 null。
  test("资源按源文件名未命中返回 null", async () => {
    stubDb({ select: () => selected([]) });
    expect(await knowledgeResourceRepo.getBySourceName("kb-1", "missing.md")).toBeNull();
  });

  // 资源列表接受调用方指定的分页上限。
  test("资源列表返回指定知识库的查询结果", async () => {
    stubDb({ select: () => selected([{ id: "resource-1" }]) });
    expect(await knowledgeResourceRepo.listByKnowledgeBase("kb-1", 5)).toEqual([{ id: "resource-1" }]);
  });

  // 资源计数没有聚合行时必须返回零。
  test("资源计数缺失时返回零", async () => {
    stubDb({ select: () => selected([]) });
    expect(await knowledgeResourceRepo.countByKnowledgeBase("kb-1")).toBe(0);
  });

  // 状态汇总应保留数据库计算出的各状态数量。
  test("资源状态汇总返回各状态计数", async () => {
    stubDb({ select: () => selected([{ readyCount: 2, activeCount: 3, errorCount: 1, totalCount: 6 }]) });
    expect(await knowledgeResourceRepo.getStatusSummary("kb-1")).toEqual({
      readyCount: 2,
      activeCount: 3,
      errorCount: 1,
      totalCount: 6,
    });
  });

  // 创建资源应返回数据库 returning 行。
  test("创建资源返回持久化行", async () => {
    const row = { id: "resource-created", ...resourceInput };
    stubDb({ insert: () => inserted(row) });
    expect(await knowledgeResourceRepo.create(resourceInput)).toEqual(row);
  });

  // 单个资源更新应保留 null 清理语义。
  test("更新资源传递 null 错误信息", async () => {
    let saved: unknown;
    stubDb({
      update: () =>
        updated((data) => {
          saved = data;
        }),
    });
    await knowledgeResourceRepo.update("resource-1", { status: "ready", lastError: null });
    expect(saved).toEqual({ status: "ready", lastError: null });
  });

  // 非空远端 ID 集合应执行批量资源更新。
  test("批量更新远端资源传递状态", async () => {
    let saved: unknown;
    stubDb({
      update: () =>
        updated((data) => {
          saved = data;
        }),
    });
    await knowledgeResourceRepo.updateByRemoteIds(["remote-1", "remote-2"], { status: "error" });
    expect(saved).toEqual({ status: "error" });
  });

  // 删除资源以 returning 行是否存在表达成功状态。
  test("删除资源未命中返回 false", async () => {
    stubDb({ delete: () => deleted() });
    expect(await knowledgeResourceRepo.delete("missing")).toBeFalse();
  });

  // 删除知识库资源应完成无返回值的删除链。
  test("按知识库删除资源完成操作", async () => {
    let called = false;
    stubDb({
      delete: () => ({
        where: () => {
          called = true;
          return Promise.resolve();
        },
      }),
    });
    await knowledgeResourceRepo.deleteByKnowledgeBase("kb-1");
    expect(called).toBeTrue();
  });

  // 非空远端 ID 集合应返回数据库匹配资源。
  test("按多个远端 ID 查询资源", async () => {
    const rows = [{ id: "resource-1" }, { id: "resource-2" }];
    stubDb({ select: () => selected(rows) });
    expect(await knowledgeResourceRepo.findByRemoteIds(["remote-1", "remote-2"])).toEqual(rows);
  });

  // 绑定列表应返回指定 agent 的所有优先级项。
  test("列出 agent 的全部知识库绑定", async () => {
    stubDb({ select: () => selected([{ id: "binding-1", enabled: false }]) });
    expect(await agentKnowledgeBindingRepo.listByAgentConfigId("agent-1")).toEqual([
      { id: "binding-1", enabled: false },
    ]);
  });

  // 已启用绑定列表应接受查询返回的启用项。
  test("列出 agent 的已启用知识库绑定", async () => {
    stubDb({ select: () => selected([{ id: "binding-enabled", enabled: true }]) });
    expect(await agentKnowledgeBindingRepo.listEnabledByAgentConfigId("agent-1")).toEqual([
      { id: "binding-enabled", enabled: true },
    ]);
  });

  // 绑定创建应返回数据库生成的绑定行。
  test("创建知识库绑定返回持久化行", async () => {
    const row = { id: "binding-created", ...bindingInput };
    stubDb({ insert: () => inserted(row) });
    expect(await agentKnowledgeBindingRepo.create(bindingInput)).toEqual(row);
  });

  // 空批量绑定不能触发数据库写入。
  test("空批量创建绑定不访问数据库", async () => {
    const insert = mock(() => {
      throw new Error("不应写入数据库");
    });
    stubDb({ insert });
    await agentKnowledgeBindingRepo.createMany([]);
    expect(insert).not.toHaveBeenCalled();
  });

  // 资源连接查询没有匹配行时返回 null。
  test("资源与知识库连接查询未命中返回 null", async () => {
    stubDb({
      select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) }),
    });
    expect(await agentKnowledgeBindingRepo.getResourceWithKnowledgeBase("missing")).toBeNull();
  });

  // 资源连接查询应拆分 resource 与知识库归属字段。
  test("资源与知识库连接查询映射嵌套资源", async () => {
    const row = {
      id: "resource-1",
      knowledgeBaseId: "kb-1",
      sourceType: "file",
      sourceName: "guide.md",
      sourcePath: null,
      remoteId: null,
      status: "ready",
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
      kbRemoteId: "remote-kb",
      kbUserId: "user-1",
      kbOrganizationId: "org-1",
      kbRemoteAccountId: null,
      kbRemoteUserId: null,
    };
    stubDb({
      select: () => ({
        from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }) }),
      }),
    });
    expect(await agentKnowledgeBindingRepo.getResourceWithKnowledgeBase("resource-1")).toEqual({
      resource: {
        id: "resource-1",
        knowledgeBaseId: "kb-1",
        sourceType: "file",
        sourceName: "guide.md",
        sourcePath: null,
        remoteId: null,
        status: "ready",
        lastError: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      kbRemoteId: "remote-kb",
      kbUserId: "user-1",
      kbOrganizationId: "org-1",
      kbRemoteAccountId: null,
      kbRemoteUserId: null,
    });
  });
});
