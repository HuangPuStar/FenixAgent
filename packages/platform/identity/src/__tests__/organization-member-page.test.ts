import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { user } from "@fenix/identity/db";
import type { DbStub } from "@fenix/platform-sdk/testing";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createIdentityDirectory } from "../services/identity-directory";

/**
 * `IdentityDirectory.listOrganizationMembers` 的存储侧契约：选列、组织谓词与分页下推。
 *
 * 为什么必须在身份包内钉住：该方法的契约面只有 `userId` 与 `name`，而消费方（工单负责人下拉框）走的是
 * 身份目录替身——替身永远发现不了真实实现多带了一列 email 或手机号。这里断言真实实现发出的 SQL：
 * 选列只有 `user.id` / `user.name`，WHERE 只含成员组织列与姓名的模糊匹配，分页参数原样进 `limit`/`offset`。
 *
 * 测试进程没有 Postgres，因此用记录型替身（仓库既有的 `stubDb` 注入路径）只收语句不执行 SQL；
 * 谓词的组织隔离因此落到「组织 id 出现在绑定参数里」这条事实上，而不是「内存里过滤过」。
 */

const dialect = new PgDialect();

/** 一次 `select()` 调用记录的形状；未走到的链式方法保持 undefined。 */
interface RecordedSelect {
  readonly projection: Record<string, unknown>;
  where?: unknown;
  orderBy?: readonly unknown[];
  limit?: number;
  offset?: number;
}

/** 链式替身：生产代码的调用顺序固定为 `select → from → innerJoin → where → orderBy → limit → offset`。 */
interface SelectChain {
  from(): SelectChain;
  innerJoin(): SelectChain;
  where(condition: unknown): SelectChain;
  orderBy(...order: readonly unknown[]): SelectChain;
  limit(value: number): SelectChain;
  offset(value: number): SelectChain;
  then<TResult1 = readonly unknown[], TResult2 = never>(
    onfulfilled?: ((value: readonly unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

/** 记录型 DB 替身：列表与合计是两次 `select()`，按投影形状（含 `value` 者为合计）分辨返回值。 */
function createMemberPageDbStub(input: {
  readonly items: readonly { readonly userId: string; readonly name: string }[];
  readonly total: number;
}): { readonly db: DbStub; readonly selects: RecordedSelect[] } {
  const selects: RecordedSelect[] = [];
  const db: DbStub = {
    select: (projection: Record<string, unknown>) => {
      const call: RecordedSelect = { projection };
      selects.push(call);
      const rows = (): readonly unknown[] => ("value" in projection ? [{ value: input.total }] : input.items);
      const builder: SelectChain = {
        from: () => builder,
        innerJoin: () => builder,
        where: (condition) => {
          call.where = condition;
          return builder;
        },
        orderBy: (...order) => {
          call.orderBy = order;
          return builder;
        },
        limit: (value) => {
          call.limit = value;
          return builder;
        },
        offset: (value) => {
          call.offset = value;
          return builder;
        },
        // biome-ignore lint/suspicious/noThenProperty: 生产代码把链式对象直接 await（列表与合计各一次），替身必须真的可 await。
        then: (onfulfilled, onrejected) => Promise.resolve(rows()).then(onfulfilled, onrejected),
      };
      return builder;
    },
  };
  return { db, selects };
}

/** 取出 Drizzle 片段的 `SQL` 对象；列对象与条件对象都实现了 `SQLWrapper`。 */
function sqlOf(value: unknown): SQL | undefined {
  if (value === null || typeof value !== "object") return;
  const wrapper = value as Partial<SQLWrapper>;
  return typeof wrapper.getSQL === "function" ? wrapper.getSQL() : undefined;
}

/** 渲染谓词文本，供断言列名与操作符。 */
function renderSql(value: unknown): string {
  const statement = sqlOf(value);
  return statement === undefined ? "" : dialect.sqlToQuery(statement).sql;
}

/** 取出谓词的绑定参数；组织 id 与关键字都必须出现在这里，否则说明它们只在内存里参与过过滤。 */
function paramsOf(value: unknown): readonly unknown[] {
  const statement = sqlOf(value);
  return statement === undefined ? [] : dialect.sqlToQuery(statement).params;
}

describe("IdentityDirectory.listOrganizationMembers", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 全量 `bun test packages/` 是同进程：用例结束时必须摘掉本文件登记的 DB 替身，否则后续文件里
  // 「未初始化读取 DB 必须失败」的契约会读到替身（先例：tickets 的仓储用例同样在 afterAll 复位）。
  afterAll(() => {
    resetAllStubs();
  });

  // 选列只允许 user.id 与 user.name，且组织谓词、分页参数原样下推；合计查询与列表共用同一份谓词。
  test("选列不含身份敏感字段，组织谓词与分页下推到 SQL", async () => {
    const stub = createMemberPageDbStub({ items: [{ userId: "user-1", name: "张三" }], total: 41 });
    stubDb(stub.db);

    const page = await createIdentityDirectory().listOrganizationMembers({
      organizationId: "org-1",
      page: 2,
      pageSize: 30,
    });

    const [list, total] = stub.selects;
    expect(Object.keys(list?.projection ?? {})).toEqual(["userId", "name"]);
    expect(list?.projection.userId).toBe(user.id);
    expect(list?.projection.name).toBe(user.name);
    expect(renderSql(list?.where)).toBe('"member"."organization_id" = $1');
    expect(paramsOf(list?.where)).toEqual(["org-1"]);
    expect(list?.limit).toBe(30);
    expect(list?.offset).toBe(30);
    expect(total?.limit).toBeUndefined();
    expect(total?.offset).toBeUndefined();
    expect(renderSql(total?.where)).toBe(renderSql(list?.where));
    expect(page).toEqual({ items: [{ userId: "user-1", name: "张三" }], total: 41 });
  });

  // 关键字只对姓名做子串匹配（trim 后原样下推），不得进入邮箱、手机号等账号标识列。
  test("关键字只匹配姓名，且以绑定参数形式下推", async () => {
    const stub = createMemberPageDbStub({ items: [], total: 0 });
    stubDb(stub.db);

    await createIdentityDirectory().listOrganizationMembers({
      organizationId: "org-1",
      keyword: "  张三  ",
      page: 1,
      pageSize: 20,
    });

    const [list] = stub.selects;
    expect(renderSql(list?.where)).toBe(
      '("member"."organization_id" = $1 and strpos(lower("user"."name"), lower($2)) > 0)',
    );
    expect(paramsOf(list?.where)).toEqual(["org-1", "张三"]);
  });

  // 元字符按字面量下推：`ilike '%…%'` 会把用户输入的 `%` / `_` 当模式字符（只输入 `%` 就列出全部成员）。
  test("关键字里的 LIKE 元字符不做通配符解释", async () => {
    const stub = createMemberPageDbStub({ items: [], total: 0 });
    stubDb(stub.db);

    await createIdentityDirectory().listOrganizationMembers({
      organizationId: "org-1",
      keyword: "%_",
      page: 1,
      pageSize: 20,
    });

    const [list] = stub.selects;
    expect(renderSql(list?.where)).not.toContain("ilike");
    expect(paramsOf(list?.where)).toEqual(["org-1", "%_"]);
  });

  // 全空白关键字等价于不筛选：否则会拼出 `%%` 谓词，让「成员候选集」白白多一次全组织扫描。
  test("空白关键字不产生姓名过滤", async () => {
    const stub = createMemberPageDbStub({ items: [], total: 0 });
    stubDb(stub.db);

    await createIdentityDirectory().listOrganizationMembers({
      organizationId: "org-1",
      keyword: "   ",
      page: 1,
      pageSize: 20,
    });

    const [list] = stub.selects;
    expect(renderSql(list?.where)).toBe('"member"."organization_id" = $1');
    expect(paramsOf(list?.where)).toEqual(["org-1"]);
  });
});
