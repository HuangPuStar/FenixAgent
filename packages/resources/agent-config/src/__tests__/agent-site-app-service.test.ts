import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AgentSiteAppRepository, SiteAppReadInput } from "../server/repositories/agent-site-app";
import { createAgentSiteAppService } from "../server/services/agent-site-app-service";
import { testListConstraint } from "./fixtures";

/**
 * 站点领域服务的读口径用例。
 *
 * 这里验证的是"业务条件被怎么拼"：站点发布范围的读口径（`private` 仅归属者）、绑定展开的顺序保持，
 * 以及写路径定位**不带**发布范围条件。
 *
 * 两层证据缺一不可：条件编译成 SQL 后按列名断言（不断言 SQL 文本全等，文本会随 Drizzle 版本变化），
 * 只能证明"下推了哪一列"；**口径本身的语义**由 `rowSatisfiesSiteCondition` 对具体行求值来证明——
 * 列名断言分不清 `or` 与 `and`，把读口径反转成"非 private 的行必须属于本人"后它照样通过。授权谓词
 * 本身由 `@fenix/access-control` 的用例覆盖，本文件只证明资源侧交出的是"业务条件"而不是复制授权 SQL。
 */

/** 记录入参的仓储替身；返回调用方给的行，不解释条件。 */
function createRecordingRepository(rows: readonly Record<string, unknown>[] = []) {
  const calls: SiteAppReadInput[] = [];
  const repository: AgentSiteAppRepository = {
    listReadable: async (input) => {
      calls.push(input);
      return rows as never;
    },
    findReadableById: async (input) => {
      calls.push(input);
      return rows.find((row) => row.id === input.resourceId) as never;
    },
    create: async () => {
      throw new Error("本用例不涉及写入");
    },
    update: async () => undefined,
    remove: async () => false,
    findByRemoteAppIdUnscoped: async () => undefined,
  };
  return { repository, calls };
}

const dialect = new PgDialect();

/** 条件编译结果；读条件下推后就是这一条 SQL 片段。 */
function sqlOf(input: SiteAppReadInput): string {
  return (input.businessWhere ?? []).map((condition) => dialect.sqlToQuery(condition).sql).join(" AND ");
}

function constraint() {
  return testListConstraint();
}

/** 取下推的发布范围条件；条件缺失直接抛错，避免用例在"没有过滤"的情况下静默通过。 */
function publishRangeOf(input: SiteAppReadInput): SQL {
  const [first] = input.businessWhere ?? [];
  if (first === undefined) throw new Error("读路径必须下推发布范围条件");
  return first;
}

// ── 读口径的离线求值 ──
//
// 为什么需要：`visibility` / `user_id` 这类"列名出现过"的断言分不清 `or` 与 `and`——把发布范围口径反转成
// "非 private 的行必须属于本人"后列名仍在，用例照绿。这里改为解释条件的 chunk 树本身，对具体行回答
// "这条站点能不能读到"：口径一反转，行的判定结果就变。
//
// 求值器只识别本条件可能出现的结构（`or` / `and` / `=` / `<>` 与绑定参数），遇到未知算子立即抛错：
// 日后改写口径时必须同步扩展本文件，而不是让用例静默通过。

/** 读条件求值用的记号：比较已把列、算子与绑定值收在一起。 */
type SiteConditionToken =
  | { readonly kind: "open" | "close" | "or" | "and" }
  | { readonly kind: "compare"; readonly column: string; readonly operator: "=" | "<>"; readonly value: unknown };

/** 读条件语法树。 */
type SiteConditionNode =
  | { readonly kind: "or" | "and"; readonly children: readonly SiteConditionNode[] }
  | { readonly kind: "compare"; readonly column: string; readonly operator: "=" | "<>"; readonly value: unknown };

/** Drizzle 的 `SQL` 节点：条件树的唯一复合结构。 */
function sqlChunksOf(node: unknown): readonly unknown[] | undefined {
  const chunks = (node as { queryChunks?: unknown } | null)?.queryChunks;
  return Array.isArray(chunks) ? chunks : undefined;
}

/** SQL 文本节点（`StringChunk`）；列与参数节点的 `value` 不是字符串数组。 */
function textOf(node: unknown): string | undefined {
  const value = (node as { value?: unknown } | null)?.value;
  return Array.isArray(value) && typeof value[0] === "string" ? value.join("") : undefined;
}

/** 列节点：与 `platform-sdk` 测试助手同形，靠 `name` + `dataType` 辨认。 */
function columnOf(node: unknown): string | undefined {
  const candidate = node as { name?: unknown; dataType?: unknown } | null;
  const name = candidate?.name;
  return typeof name === "string" && candidate?.dataType !== undefined ? name : undefined;
}

function pushTextToken(text: string, tokens: SiteConditionToken[]): void {
  const trimmed = text.trim();
  if (trimmed === "") return;
  if (trimmed === "(") tokens.push({ kind: "open" });
  else if (trimmed === ")") tokens.push({ kind: "close" });
  else if (trimmed === "or") tokens.push({ kind: "or" });
  else if (trimmed === "and") tokens.push({ kind: "and" });
  else throw new Error(`站点读条件求值器不支持的记号：${trimmed}`);
}

/** 把 chunk 树摊平成记号流；比较算子在摊平期就完成识别（列之后紧跟算子与参数）。 */
function tokenizeCondition(chunks: readonly unknown[], tokens: SiteConditionToken[]): void {
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined || chunk === null) continue;
    const nested = sqlChunksOf(chunk);
    if (nested !== undefined) {
      tokenizeCondition(nested, tokens);
      continue;
    }
    const column = columnOf(chunk);
    if (column !== undefined) {
      const operator = textOf(chunks[index + 1])?.trim();
      if (operator !== "=" && operator !== "<>") {
        throw new Error(`站点读条件求值器不支持的运算符：${operator}`);
      }
      const param = chunks[index + 2] as { value?: unknown; encoder?: unknown } | undefined;
      if (param?.encoder === undefined) throw new Error("站点读条件求值器：比较算子右侧不是绑定参数");
      tokens.push({ kind: "compare", column, operator, value: param.value });
      index += 2;
      continue;
    }
    const text = textOf(chunk);
    if (text === undefined) throw new Error("站点读条件求值器不支持的 chunk");
    pushTextToken(text, tokens);
  }
}

/** 递归下降解析：`or` 优先级最低，括号与比较为基本单元。 */
function parseCondition(tokens: readonly SiteConditionToken[]): SiteConditionNode {
  let cursor = 0;
  const parsePrimary = (): SiteConditionNode => {
    const token = tokens[cursor];
    if (token === undefined) throw new Error("站点读条件求值器：表达式提前结束");
    if (token.kind === "open") {
      cursor += 1;
      const node = parseOr();
      if (tokens[cursor]?.kind !== "close") throw new Error("站点读条件求值器：括号未闭合");
      cursor += 1;
      return node;
    }
    if (token.kind === "compare") {
      cursor += 1;
      return token;
    }
    throw new Error(`站点读条件求值器：意外的记号 ${token.kind}`);
  };
  const parseAnd = (): SiteConditionNode => {
    const children: SiteConditionNode[] = [parsePrimary()];
    while (tokens[cursor]?.kind === "and") {
      cursor += 1;
      children.push(parsePrimary());
    }
    return children.length === 1 ? (children[0] as SiteConditionNode) : { kind: "and", children };
  };
  const parseOr = (): SiteConditionNode => {
    const children: SiteConditionNode[] = [parseAnd()];
    while (tokens[cursor]?.kind === "or") {
      cursor += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? (children[0] as SiteConditionNode) : { kind: "or", children };
  };

  const node = parseOr();
  if (cursor !== tokens.length) throw new Error("站点读条件求值器：存在未消费的记号");
  return node;
}

function evaluateCondition(node: SiteConditionNode, row: Readonly<Record<string, unknown>>): boolean {
  if (node.kind === "or") return node.children.some((child) => evaluateCondition(child, row));
  if (node.kind === "and") return node.children.every((child) => evaluateCondition(child, row));
  const actual = row[node.column];
  // 列缺失或为 NULL 时比较结果是 SQL 的 NULL（不为真）：按"不命中"处理，而不是让 JS 的 undefined
  // 恰好"不等于 private"就算作非私有。
  if (actual === undefined || actual === null) return false;
  return node.operator === "=" ? actual === node.value : actual !== node.value;
}

/**
 * 判断一行站点数据是否满足读条件；行以 **SQL 列名**为键（如 `visibility` / `user_id`）。
 *
 * 语义由**条件本身**决定，与产出口径的实现无关：口径反转（`or` ↔ `and`、`<>` ↔ `=`、换掉绑定的用户）时
 * 同一批行的判定结果随之改变，这正是"按列名断言"给不出的证据。
 */
function rowSatisfiesSiteCondition(condition: SQL, row: Readonly<Record<string, unknown>>): boolean {
  const tokens: SiteConditionToken[] = [];
  tokenizeCondition(condition.queryChunks as readonly unknown[], tokens);
  return evaluateCondition(parseCondition(tokens), row);
}

describe("站点领域服务", () => {
  // 列表读口径：`private` 只对归属者可见（其余发布范围对同组织成员可见），并按创建时间升序排列。
  test("listVisible 同时下推发布范围条件与创建时间排序", async () => {
    const { repository, calls } = createRecordingRepository();
    const service = createAgentSiteAppService(repository);

    await service.listVisible({ access: constraint(), userId: "user-1" });

    expect(calls).toHaveLength(1);
    const sql = sqlOf(calls[0] as SiteAppReadInput);
    // 两个分支都要出现：`visibility <> 'private'`（非私有）与 `user_id = <当前用户>`（归属者）。
    expect(sql).toContain("visibility");
    expect(sql).toContain("user_id");
    expect(dialect.sqlToQuery((calls[0] as SiteAppReadInput).businessOrder?.[0] as never).sql).toContain("created_at");
  });

  // 读口径按行判定：只有「private 且非本人」的行被排除，本人自己的 private 行与其余发布范围
  // （org / authenticated / public）对他人都可见；列表与详情必须给出同一套判定。
  test("发布范围读口径按行判定：仅 private 且非本人的行被排除", async () => {
    const { repository, calls } = createRecordingRepository();
    const service = createAgentSiteAppService(repository);

    await service.listVisible({ access: constraint(), userId: "user-1" });
    await service.findVisible({ access: constraint(), userId: "user-1", resourceId: "app-uuid-1" });

    const readFilters: ReadonlyArray<readonly [string, SQL]> = [
      ["列表", publishRangeOf(calls[0] as SiteAppReadInput)],
      ["详情", publishRangeOf(calls[1] as SiteAppReadInput)],
    ];
    // 样本行带着详情的定位 ID（`app-uuid-1`），因此两处条件的差异只剩发布范围口径本身。
    const samples = [
      { label: "他人的 private", row: { id: "app-uuid-1", visibility: "private", user_id: "user-2" }, readable: false },
      { label: "本人的 private", row: { id: "app-uuid-1", visibility: "private", user_id: "user-1" }, readable: true },
      { label: "他人的 org", row: { id: "app-uuid-1", visibility: "org", user_id: "user-2" }, readable: true },
      {
        label: "他人的 authenticated",
        row: { id: "app-uuid-1", visibility: "authenticated", user_id: "user-2" },
        readable: true,
      },
      { label: "他人的 public", row: { id: "app-uuid-1", visibility: "public", user_id: "user-2" }, readable: true },
    ] as const;

    for (const [path, filter] of readFilters) {
      for (const sample of samples) {
        expect([path, sample.label, rowSatisfiesSiteCondition(filter, sample.row)]).toEqual([
          path,
          sample.label,
          sample.readable,
        ]);
      }
    }
  });

  // 详情读口径与列表一致，并且按资源 ID / 远端 app id 两种定位方式产生不同条件、固定取一行。
  test("findVisible 按定位方式取单行且口径与列表一致", async () => {
    const { repository, calls } = createRecordingRepository();
    const service = createAgentSiteAppService(repository);

    await service.findVisible({ access: constraint(), userId: "user-1", remoteAppId: "app-remote" });

    const input = calls[0] as SiteAppReadInput;
    expect(input.limit).toBe(1);
    expect(sqlOf(input)).toContain("remote_app_id");
    expect(sqlOf(input)).toContain("visibility");
  });

  // 写路径与绑定编排的定位**不带**发布范围条件：管理员能删除他人的 private 站点（既有契约），
  // 绑定表也只要求站点属于当前组织。
  test("findInOrganization 不加发布范围条件", async () => {
    const { repository, calls } = createRecordingRepository();
    const service = createAgentSiteAppService(repository);

    await service.findInOrganization({ access: constraint(), resourceId: "app-uuid-1" });

    const sql = sqlOf(calls[0] as SiteAppReadInput);
    expect(sql).toContain("id");
    expect(sql).not.toContain("visibility");
    expect(sql).not.toContain("user_id");
  });

  // 定位必须给出 ID 或远端 ID：两者都没有时抛错，避免退化成"读全组织"。
  test("findInOrganization 缺少定位参数时报错", async () => {
    const { repository } = createRecordingRepository();
    const service = createAgentSiteAppService(repository);

    await expect(service.findInOrganization({ access: constraint() })).rejects.toThrow("站点定位需要");
  });

  // 绑定展开按调用方给定的绑定顺序返回，而不是数据库返回顺序；口径与列表一致。
  test("listVisibleByIds 保持绑定顺序", async () => {
    const { repository, calls } = createRecordingRepository([
      { id: "b", name: "B" },
      { id: "a", name: "A" },
    ]);
    const service = createAgentSiteAppService(repository);

    const rows = await service.listVisibleByIds({
      access: constraint(),
      userId: "user-1",
      ids: ["a", "b"],
    });

    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(sqlOf(calls[0] as SiteAppReadInput)).toContain("visibility");
  });

  // 空 ID 集合直接返回空数组：不产生一次"IN ()"查询（该 SQL 在 PG 里是语法错误）。
  test("listVisibleByIds 空集合不查库", async () => {
    const { repository, calls } = createRecordingRepository();
    const service = createAgentSiteAppService(repository);

    expect(await service.listVisibleByIds({ access: constraint(), userId: "user-1", ids: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // 发布面定位走无授权读取：站点代理没有 actor，本地只按远端 app id 取行。
  test("findPublishTargetByRemoteAppId 走无授权读取", async () => {
    const reads: string[] = [];
    const repository: AgentSiteAppRepository = {
      listReadable: async () => [],
      findReadableById: async () => undefined,
      create: async () => {
        throw new Error("本用例不涉及创建");
      },
      update: async () => undefined,
      remove: async () => false,
      findByRemoteAppIdUnscoped: async (remoteAppId) => {
        reads.push(remoteAppId);
        return;
      },
    };
    const service = createAgentSiteAppService(repository);

    expect(await service.findPublishTargetByRemoteAppId("app-x")).toBeUndefined();
    expect(reads).toEqual(["app-x"]);
  });
});
