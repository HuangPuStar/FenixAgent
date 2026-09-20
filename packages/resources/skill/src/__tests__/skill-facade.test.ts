import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceAccess, ResourceQueryConstraint } from "@fenix/platform-sdk";
import { ConflictError, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { skillResource } from "../server/access/skill-resource";
import { SkillFacade } from "../server/facades/skill-facade";
import { skillContentPath } from "../server/services/skill-content";
import { createStubSkillService, initializeSkillModuleConfig } from "../server/testing";
import {
  authorizedSkill,
  createFakeAccessControl,
  createRecordingScopeStore,
  denied,
  scopedSkill,
  testActor,
  testListConstraint,
} from "./fixtures";

/**
 * Skill 资源应用 Facade 用例。
 *
 * 覆盖"授权编排 + 双介质（文件内容 / 资源行）补偿写入"两类行为：授权判断本身由 `access-control`
 * 用例负责，内容层的备份与归档由 `skill-archive-lifecycle` 覆盖；这里验证 Facade 是否在正确的时机
 * 用正确的输入调用了授权能力，以及两个介质的写入顺序在失败时是否留下可见不一致。
 *
 * 文件内容用**真实文件系统**（临时目录）而不是替身：补偿写入的语义就是"文件与资源行谁先谁后、
 * 失败时各自回到什么状态"，用替身断言调用序列会把这类问题掩盖掉。
 */

const actor = testActor();

function buildFacade(
  overrides: {
    service?: Parameters<typeof createStubSkillService>[0];
    accessControl?: Parameters<typeof createFakeAccessControl>[0];
    scope?: { organizationId?: string; ownerUserId?: string; visibility: "private" | "public" };
  } = {},
) {
  const { store, updates } = createRecordingScopeStore(
    overrides.scope ?? { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
  );
  const facade = new SkillFacade(createStubSkillService(overrides.service), {
    accessControl: createFakeAccessControl(overrides.accessControl),
    resource: skillResource.definition,
    scopeStore: store,
  });
  return { facade, updates };
}

/** 读取临时目录里的 SKILL.md 正文；不存在时返回 null，便于断言"文件未写入"。 */
function readContent(organizationId: string, name: string): string | null {
  try {
    return readFileSync(skillContentPath(organizationId, name), "utf-8");
  } catch {
    return null;
  }
}

let skillRoot = "";

beforeEach(() => {
  skillRoot = join(tmpdir(), `fenix-skill-facade-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(skillRoot, { recursive: true });
  initializeSkillModuleConfig({ skillDir: skillRoot });
});

afterEach(() => {
  rmSync(skillRoot, { recursive: true, force: true });
});

describe("SkillFacade 列表与详情", () => {
  // 列表把授权条件、排序与分页下推给领域服务，并只用一次批量查询补齐权限，避免逐行 N+1。
  test("list 下推条件与分页并批量补齐权限", async () => {
    const listInputs: { access: ResourceQueryConstraint; limit?: number; offset?: number }[] = [];
    const batchCalls: string[][] = [];
    const { facade } = buildFacade({
      service: {
        list: async (input) => {
          listInputs.push(input);
          return { items: [scopedSkill({ id: "skill-1" }), scopedSkill({ id: "skill-2", name: "other" })], total: 7 };
        },
      },
      accessControl: {
        resolveAccessMany: async ({ resourceIds }) => {
          batchCalls.push([...resourceIds]);
          const access: ResourceAccess = { actions: ["read"] };
          return new Map(resourceIds.map((id) => [id, access]));
        },
      },
    });

    const result = await facade.list(actor, { limit: 2, offset: 4 });

    expect(result.total).toBe(7);
    expect(batchCalls).toEqual([["skill-1", "skill-2"]]);
    expect(listInputs[0]?.limit).toBe(2);
    expect(listInputs[0]?.offset).toBe(4);
    expect(listInputs[0]?.access).toEqual(testListConstraint());
    expect(result.items[0]?.access).toEqual({ actions: ["read"] });
  });

  // 空列表不发起批量权限查询：没有资源就没有需要补齐的 access。
  test("list 空结果不查询权限", async () => {
    let projected = false;
    const { facade } = buildFacade({
      service: { list: async () => ({ items: [], total: 0 }) },
      accessControl: {
        resolveAccessMany: async () => {
          projected = true;
          return new Map();
        },
      },
    });

    expect(await facade.list(actor)).toEqual({ items: [], total: 0 });
    expect(projected).toBeFalse();
  });

  // 名称解析先看当前组织，未命中再放宽到跨组织可见集合；两次查询共用同一个授权条件。
  test("get 名称按当前组织优先解析，未命中时跨组织再查", async () => {
    const calls: { name: string; organizationId?: string }[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async (input) => {
          calls.push({
            name: input.name,
            ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
          });
          return input.organizationId === undefined
            ? scopedSkill({ id: "skill-shared", organizationId: "org-source" })
            : undefined;
        },
      },
    });

    const item = await facade.get(actor, "demo");

    expect(calls).toEqual([{ name: "demo", organizationId: "org-1" }, { name: "demo" }]);
    expect(item?.id).toBe("skill-shared");
  });

  // 资源键带 `/`：按键里的归属组织定位，键与行的组织不一致时由仓储的 WHERE 条件挡下。
  test("get 资源键按归属组织定位", async () => {
    const keys: string[] = [];
    const { facade } = buildFacade({
      service: {
        findByResourceKey: async ({ resourceKey }) => {
          keys.push(resourceKey);
          return scopedSkill({ id: "skill-external", organizationId: "org-source", visibility: "public" });
        },
      },
    });

    const item = await facade.get(actor, "org-source/skill-external");

    expect(keys).toEqual(["org-source/skill-external"]);
    expect(item?.path).toBe(`${skillRoot}/org-source/demo/SKILL.md`);
  });

  // 内容缺失（文件被外部删除）不阻塞详情：正文为空、描述回落资源行列。
  test("readDetail 内容缺失时回落资源行描述", async () => {
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedSkill({ description: "行里的描述" }),
      },
    });

    const detail = await facade.readDetail(actor, "demo");

    expect(detail?.content).toBe("");
    expect(detail?.description).toBe("行里的描述");
    expect(detail?.metadata).toEqual({});
  });
});

describe("SkillFacade 写入与补偿", () => {
  // 同组织同名由唯一索引判定（insert 返回空集）：Facade 映射为 409，且完全不触碰文件系统。
  test("create 同组织同名冲突映射为 ConflictError", async () => {
    const { facade } = buildFacade({ service: { create: async () => undefined } });

    await expect(facade.create(actor, { name: "demo", data: { description: "d", content: "# Demo" } })).rejects.toThrow(
      ConflictError,
    );
    expect(readContent("org-1", "demo")).toBeNull();
  });

  // 内容写入失败时删除刚建好的资源行：行与内容都回到"不存在"，不留只存在于一侧的中间态。
  test("create 内容写入失败时删除刚建的行", async () => {
    const removed: string[] = [];
    // 用同名文件占住 Skill 目录：mkdir 失败，模拟磁盘/目录被占用导致的写入失败。
    mkdirSync(join(skillRoot, "org-1"), { recursive: true });
    writeFileSync(join(skillRoot, "org-1", "demo"), "占位文件");
    const { facade } = buildFacade({
      service: {
        create: async () => "skill-1",
        remove: async ({ resourceId }) => {
          removed.push(resourceId);
          return true;
        },
      },
    });

    await expect(
      facade.create(actor, { name: "demo", data: { description: "d", content: "# Demo" } }),
    ).rejects.toThrow();

    expect(removed).toEqual(["skill-1"]);
  });

  // 没有活动组织的主体不能创建组织资源：平台拒绝映射为对外 403 而不是 500。
  test("create 缺少活动组织映射为 ForbiddenError", async () => {
    const { facade } = buildFacade();

    await expect(
      facade.create(testActor({ activeOrganizationId: undefined }), {
        name: "demo",
        data: { description: "d", content: "# Demo" },
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  // 保存文档：文件内容写入与资源行写入在同一份快照保护下完成，行侧拿到的是最终落盘的描述。
  test("update 写入文件并把资源行写入放进同一份快照", async () => {
    mkdirSync(join(skillRoot, "org-1", "demo"), { recursive: true });
    writeFileSync(skillContentPath("org-1", "demo"), "---\nname: demo\ndescription: 旧\n---\n\n# 旧\n");
    const rowWrites: { resourceId: string; description?: string }[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedSkill({ description: "旧" }),
        update: async ({ resourceId, data }) => {
          rowWrites.push({ resourceId, ...(data.description === undefined ? {} : { description: data.description }) });
          return true;
        },
        findById: async () => scopedSkill({ description: "新" }),
      },
    });

    await facade.update(actor, "demo", { description: "新", content: "# 新" });

    expect(readContent("org-1", "demo")).toContain("# 新");
    expect(rowWrites).toEqual([{ resourceId: "skill-1", description: "新" }]);
  });

  // 资源行写入失败（并发删除、数据库故障）时恢复文件内容：不会出现"文件已改、行说旧值"的错位。
  test("update 资源行写入失败时恢复文件内容", async () => {
    mkdirSync(join(skillRoot, "org-1", "demo"), { recursive: true });
    const original = "---\nname: demo\ndescription: 旧\n---\n\n# 旧\n";
    writeFileSync(skillContentPath("org-1", "demo"), original);
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedSkill({ description: "旧" }),
        update: async () => false,
      },
    });

    await expect(facade.update(actor, "demo", { description: "新", content: "# 新" })).rejects.toThrow(NotFoundError);

    expect(readContent("org-1", "demo")).toBe(original);
  });

  // 更新动作被拒时映射为 403，且不写文件。
  test("update 未获更新动作时映射为 ForbiddenError", async () => {
    const { facade } = buildFacade({
      service: { findByName: async () => scopedSkill() },
      accessControl: { authorize: async () => denied() },
    });

    await expect(facade.update(actor, "demo", { description: "新", content: "# 新" })).rejects.toThrow(ForbiddenError);
    expect(readContent("org-1", "demo")).toBeNull();
  });

  // 公开受众是资源授权数据而不是文档内容：只改归属范围，不读也不重写 SKILL.md。
  test("setPublicReadable 只改公开受众，不重写文档", async () => {
    mkdirSync(join(skillRoot, "org-1", "demo"), { recursive: true });
    const original = "---\nname: demo\ndescription: d\n---\n\n# Demo\n";
    writeFileSync(skillContentPath("org-1", "demo"), original);
    const { facade, updates } = buildFacade({
      service: {
        findByName: async () => scopedSkill(),
        findById: async () => scopedSkill({ visibility: "public" }),
      },
    });

    await facade.setPublicReadable(actor, "demo", true);

    expect(updates).toEqual([{ organizationId: "org-1", ownerUserId: "user-1", visibility: "public" }]);
    expect(readContent("org-1", "demo")).toBe(original);
  });

  // 删除先删资源行再清理内容：行删不掉（并发删除）时文件保持原样，不产生"行还在但内容没了"。
  test("remove 资源行删除失败时保留文件内容", async () => {
    mkdirSync(join(skillRoot, "org-1", "demo"), { recursive: true });
    writeFileSync(skillContentPath("org-1", "demo"), "# Demo");
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedSkill(),
        remove: async () => false,
      },
    });

    await expect(facade.remove(actor, "demo")).rejects.toThrow(NotFoundError);
    expect(readContent("org-1", "demo")).toContain("# Demo");
  });

  // 删除成功后同步清理源目录与归档：内容只在归属组织目录下存在一份。
  test("remove 成功后清理源目录与归档", async () => {
    mkdirSync(join(skillRoot, "org-1", "demo"), { recursive: true });
    writeFileSync(skillContentPath("org-1", "demo"), "# Demo");
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedSkill(),
        remove: async () => true,
      },
    });

    await facade.remove(actor, "demo");

    expect(readContent("org-1", "demo")).toBeNull();
  });
});

describe("SkillFacade 导入", () => {
  // 冲突探测按当前组织查询：本组织已有同名资源时先返回冲突清单，等用户决定策略，不做破坏性写入。
  test("importDirectories 命中本组织同名时返回冲突且不写入", async () => {
    const conflictQueries: { names: readonly string[]; organizationId: string }[] = [];
    const { facade } = buildFacade({
      service: {
        listByNames: async (input) => {
          conflictQueries.push({ names: input.names, organizationId: input.organizationId });
          // 名单为空表示回读阶段（导入被冲突拦下，没有任何条目需要回读）。
          return input.names.length === 0 ? [] : [scopedSkill({ id: "skill-existing", name: "demo" })];
        },
      },
    });

    const result = await facade.importDirectories(actor, [
      { skillName: "demo", relativePath: "SKILL.md", content: "---\nname: demo\n---\nBody" },
    ]);

    expect(conflictQueries[0]?.organizationId).toBe("org-1");
    expect(result.conflicts.map((conflict) => conflict.name)).toEqual(["demo"]);
    expect(result.imported).toEqual([]);
    expect(readContent("org-1", "demo")).toBeNull();
  });

  // 跨组织公开的同名 Skill 不在本组织的冲突探测结果里：同名导入因此可以共存，而不是被误判为冲突。
  test("importDirectories 不把跨组织同名资源算作冲突", async () => {
    let probes = 0;
    const { facade } = buildFacade({
      service: {
        listByNames: async () => {
          probes += 1;
          // 第一次是冲突探测：本组织没有同名资源（跨组织的公开副本不在授权查询结果里）。
          if (probes === 1) return [];
          return [scopedSkill({ id: "skill-new", name: "demo" })];
        },
        upsertByOrgAndName: async () => "skill-new",
      },
    });

    const result = await facade.importDirectories(actor, [
      { skillName: "demo", relativePath: "SKILL.md", content: "---\nname: demo\n---\nBody" },
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.imported.map((item) => item.name)).toEqual(["demo"]);
    expect(readContent("org-1", "demo")).toContain("Body");
  });

  // 覆盖导入失败时把被覆盖的资源行恢复为导入前的内容，而不是删除记录（删除会丢掉旧元数据）。
  test("importDirectories 覆盖失败时恢复被覆盖的资源行", async () => {
    mkdirSync(join(skillRoot, "org-1", "demo"), { recursive: true });
    writeFileSync(skillContentPath("org-1", "demo"), "---\nname: demo\ndescription: 旧\n---\n\n# 旧\n");
    const existing = scopedSkill({ id: "skill-1", name: "demo", description: "旧" });
    const rowWrites: { description?: string }[] = [];
    let writeCount = 0;
    const { facade } = buildFacade({
      service: {
        listByNames: async () => [existing],
        upsertByOrgAndName: async (input) => {
          writeCount += 1;
          rowWrites.push({ ...(input.data.description === undefined ? {} : { description: input.data.description }) });
          // 第一次是导入写入，失败触发回滚；第二次是回滚补偿，必须成功。
          if (writeCount === 1) throw new Error("pg down");
          return "skill-1";
        },
      },
    });

    await expect(
      facade.importDirectories(
        actor,
        [{ skillName: "demo", relativePath: "SKILL.md", content: "---\nname: demo\ndescription: 新\n---\n\n# 新\n" }],
        "overwrite",
      ),
    ).rejects.toThrow("pg down");

    expect(rowWrites).toEqual([{ description: "新" }, { description: "旧" }]);
    expect(readContent("org-1", "demo")).toContain("# 旧");
  });

  // 空上传在写入前就被拒绝：校验失败属于请求错误，不应该留下任何文件或资源行。
  test("importDirectories 空上传被拒绝且不写入", async () => {
    const { facade } = buildFacade();

    await expect(facade.importDirectories(actor, [])).rejects.toThrow("未提供任何上传文件");
    expect(readContent("org-1", "demo")).toBeNull();
  });
});

describe("SkillFacade 授权映射", () => {
  // 列表条件由平台产出：Facade 不自行拼装组织或公开条件。
  test("列表条件来自授权模块而不是本地拼装", async () => {
    const constraints: ResourceQueryConstraint[] = [];
    const { facade } = buildFacade({
      service: { list: async () => ({ items: [], total: 0 }) },
      accessControl: {
        createListConstraint: async () => {
          const constraint = testListConstraint();
          constraints.push(constraint);
          return constraint;
        },
      },
    });

    await facade.list(actor);

    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.provider).toBe("test-access-control");
  });

  // 详情视图必须带归属范围与有效动作，`/web` 与 `/api` 的响应都由这两个字段派生。
  test("详情视图带 scope 与 access", async () => {
    const { facade } = buildFacade({
      service: { findByName: async () => scopedSkill({ visibility: "public" }) },
    });

    const item = await facade.get(actor, "demo");

    expect(item).toEqual(authorizedSkill({ visibility: "public", path: skillContentPath("org-1", "demo") }));
  });
});
