/**
 * 授权查询的 **SQL 拼装层**契约（设计 §3.5）。
 *
 * `DrizzleAuthorizedResourceQuery` 是授权条件真正落到 SQL 的地方：列解析、`scopeOfRow`、`list` /
 * `count` / `findById` 的谓词拼装都在它手里。谓词本身的等价性由 `authorization-consistency.test.ts`
 * 覆盖，但那只到「谓词对象」为止；把谓词放进 WHERE 的这一段此前没有任何用例——少一个组织条件、
 * `count` 与 `list` 拼出不同的 WHERE、分页作用在未过滤的集合上，都会在其余测试全绿的情况下串租户。
 *
 * 用例驱动的都是真实实现：条件由真实的 `createListConstraint` 产出，SQL 由
 * `DrizzleAuthorizedResourceQuery` 真实构造。替身只替换 DB 句柄，fixture 与「不覆盖哪些数据库
 * 行为」见 `authorized-query-harness.ts`。
 */

import { expect, test } from "bun:test";
import { RESOURCE_QUERY_CONSTRAINT_PAYLOAD, type ResourceQueryConstraint } from "@fenix/platform-sdk";
import { asc, eq } from "drizzle-orm";
import {
  createHarness,
  ids,
  listInput,
  ORG_A_MEMBER,
  ORG_A_OWNER,
  ORG_B_ADMIN,
  ORGANIZATION_PERSONAL_RESOURCE,
  ORGANIZATION_RESOURCE,
  ORGANIZATION_RESOURCE_TYPE,
  OUTSIDE_MEMBER,
  PERSONAL_RESOURCE_TYPE,
  PROBE_ROWS,
  probeTable,
  render,
  SUPER_ADMIN,
  whereOf,
} from "./authorized-query-harness";

// 组织资源 + private：同组织成员能看到本组织全部归属行；另一组织的成员（即使它也是本组织成员）看不到。
test("同组织私有行对组织成员可见、对另一组织不可见", async () => {
  const { suite } = createHarness();
  const asMember = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });
  const asOtherOrganization = await suite.accessControl.createListConstraint({
    actor: ORG_B_ADMIN,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  const memberView = await suite.authorizedQuery.list(listInput({ access: asMember }));
  const otherView = await suite.authorizedQuery.list(listInput({ access: asOtherOrganization }));

  expect(ids(memberView.items)).toEqual(["c-public", "a-private", "a-public", "a-archived", "a-no-visibility"]);
  expect(ids(otherView.items)).toEqual(["b-private", "c-public", "a-public"]);
  // u4 是 org-a 的成员，但当前组织是 org-b：成员关系本身不构成归属，org-a 的私有行必须仍然不可见。
  expect(ids(otherView.items)).not.toContain("a-private");
});

// 组织内个人资源：隔离的是「当前组织 + owner 本人」，同组织的其他成员同样不可见（设计 §5.5）。
test("组织内个人资源对同组织 owner 本人可见、对同组织其他成员不可见", async () => {
  const { suite } = createHarness();
  const asOwner = await suite.accessControl.createListConstraint({
    actor: ORG_A_OWNER,
    action: "read",
    resource: ORGANIZATION_PERSONAL_RESOURCE,
  });
  const asColleague = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_PERSONAL_RESOURCE,
  });

  const ownerView = await suite.authorizedQuery.list(
    listInput({ access: asOwner, resourceType: PERSONAL_RESOURCE_TYPE }),
  );
  const colleagueView = await suite.authorizedQuery.list(
    listInput({ access: asColleague, resourceType: PERSONAL_RESOURCE_TYPE }),
  );

  // 公开受众在归属规则之外叠加：owner 自己名下三行 + 丙组织的公开行。
  expect(ids(ownerView.items)).toEqual(["c-public", "a-private", "a-public", "a-no-visibility"]);
  // 同组织同事看到自己的行与全部公开行，看不到 u1 名下的私有行。
  expect(ids(colleagueView.items)).toEqual(["c-public", "a-public", "a-archived"]);
  expect(ids(colleagueView.items)).not.toContain("a-private");
});

// public 跨组织可见：非成员组织的调用方也能查到公开行，但私有行一行都不进结果集。
test("visibility=public 的行跨组织可见，私有行不因同一查询泄露", async () => {
  const { suite } = createHarness();
  const access = await suite.accessControl.createListConstraint({
    actor: OUTSIDE_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  const page = await suite.authorizedQuery.list(listInput({ access }));

  expect(ids(page.items)).toEqual(["c-public", "a-public"]);
});

// 归属条件只匹配当前 active organization：SQL 参数里只能出现一个组织 id，否则等于把「我是成员的全部组织」并集进来。
test("两个组织的数据互不串，归属条件只带当前组织一个值", async () => {
  const { suite, queries } = createHarness();
  const asOrgA = await suite.accessControl.createListConstraint({
    actor: ORG_A_OWNER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });
  const asOrgB = await suite.accessControl.createListConstraint({
    actor: ORG_B_ADMIN,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  const orgAView = await suite.authorizedQuery.list(listInput({ access: asOrgA }));
  const orgBView = await suite.authorizedQuery.list(listInput({ access: asOrgB }));

  expect(ids(orgAView.items)).not.toContain("b-private");
  expect(ids(orgBView.items)).not.toContain("a-private");
  // 参数是「归属组织 + 公开受众」两段：出现第二个组织 id 就说明谓词退化成了成员组织并集。
  expect(render(whereOf(queries[0])).params).toEqual(["org-a", "public"]);
  expect(render(whereOf(queries[1])).params).toEqual(["org-b", "public"]);
});

// count 与 list 必须由同一份 WHERE 派生：分页 total 来自 count，错一处就会出现「有总数没数据」或反之。
test("count 与 list 在同一约束下数量一致且 WHERE 逐字相同", async () => {
  const { suite, queries } = createHarness();
  const access = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });
  const businessWhere = [eq(probeTable.status, "active")];

  const page = await suite.authorizedQuery.list(listInput({ access, businessWhere }));
  const total = await suite.authorizedQuery.count(listInput({ access, businessWhere }));

  // 期望值直接写死在 fixture 上（可见行 5 行，减去被业务条件排除的归档行），不跟随替身的过滤逻辑，
  // 从而独立于被测实现。
  expect(total).toBe(4);
  expect(total).toBe(page.items.length);
  // list 在前、count 在后：两条语句的 WHERE 必须逐字相同（文本与参数都比）。
  expect(render(whereOf(queries[1]))).toEqual(render(whereOf(queries[0])));
  // 计数用聚合而不是把行读回来在内存里数：投影不是 count(*) 就说明分页下推被绕过。
  expect(Object.values(queries[1].projection ?? {}).map((field) => render(field).sql)).toEqual(["count(*)"]);
});

// 业务条件与授权谓词同处一个 WHERE：任一方都不能覆盖另一方，否则越权或漏数据二者必居其一。
test("业务条件与授权条件同时生效，互不覆盖", async () => {
  const { suite, queries } = createHarness();
  const access = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  const page = await suite.authorizedQuery.list(
    listInput({ access, businessWhere: [eq(probeTable.status, "active")] }),
  );

  // a-archived 授权放行但业务条件不放行；b-private 业务条件放行但授权不放行——两者缺席即说明发生了覆盖。
  expect(ids(page.items)).not.toContain("a-archived");
  expect(ids(page.items)).not.toContain("b-private");
  expect(ids(page.items)).toEqual(["c-public", "a-private", "a-public", "a-no-visibility"]);
  expect(render(whereOf(queries[0])).params).toEqual(["org-a", "public", "active"]);
});

// 排序与分页必须与授权条件落在同一条语句里：切片发生在授权过滤之后，不做全量读取再内存过滤（设计 §3.5）。
test("分页下推到 SQL 且作用在已授权集合上", async () => {
  const { suite, queries } = createHarness();
  const access = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  const page = await suite.authorizedQuery.list(listInput({ access, businessOrder: [asc(probeTable.id)], limit: 2 }));

  // 未授权的前两行是 b-private / c-public 中的一半：结果若从这里取，说明切片发生早于授权过滤。
  expect(ids(page.items)).toEqual(["c-public", "a-private"]);
  expect(queries[0].limit).toBe(2);
  expect(queries[0].orderBy).toHaveLength(1);
  expect(render(whereOf(queries[0])).params).toEqual(["org-a", "public"]);
});

// 行携带的 scope 由主表归属列还原：范围来自行本身，未写明 visibility 按 private，绝不把未知取值当公开。
test("返回行的 scope 由主表归属列还原而非调用方上下文", async () => {
  const { suite } = createHarness();
  const asMember = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });
  const asOutside = await suite.accessControl.createListConstraint({
    actor: OUTSIDE_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  const memberView = await suite.authorizedQuery.list(listInput({ access: asMember }));
  const outsideView = await suite.authorizedQuery.list(listInput({ access: asOutside }));
  const scopes = new Map(memberView.items.map((item) => [item.id, item.scope]));

  expect(scopes.get("a-no-visibility")).toEqual({ organizationId: "org-a", ownerUserId: "u1", visibility: "private" });
  expect(scopes.get("a-archived")).toEqual({ organizationId: "org-a", ownerUserId: "u2", visibility: "private" });
  // 调用方当前组织是 org-d，公开行的范围仍然是行自己的 org-c。
  expect(outsideView.items.map((item) => item.scope)).toEqual([
    { organizationId: "org-c", ownerUserId: "u3", visibility: "public" },
    { organizationId: "org-a", ownerUserId: "u1", visibility: "public" },
  ]);
});

// 详情路径共用同一份 WHERE：知道别的组织的 resourceId 不代表能读到它，且只取一行。
test("findById 复用授权条件，跨组织私有资源返回未命中", async () => {
  const { suite, queries } = createHarness();
  const access = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });
  const input = { ...listInput({ access }), resourceId: "a-private" };

  const found = await suite.authorizedQuery.findById(input);
  const foreign = await suite.authorizedQuery.findById({ ...input, resourceId: "b-private" });

  expect(found?.id).toBe("a-private");
  expect(found?.scope).toEqual({ organizationId: "org-a", ownerUserId: "u1", visibility: "private" });
  expect(foreign).toBeUndefined();
  expect(queries[0].limit).toBe(1);
  expect(render(whereOf(queries[1])).params).toEqual(["org-a", "public", "b-private"]);
});

// 系统管理员的 bypass 靠**省略谓词**实现（设计 §5）：这里断言它确实不过滤，且没有退化成恒真条件。
test("super-admin 的 bypass 省略授权谓词并放行全部行", async () => {
  const { suite, queries } = createHarness();
  const access = await suite.accessControl.createListConstraint({
    actor: SUPER_ADMIN,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  const page = await suite.authorizedQuery.list(listInput({ access }));

  expect(ids(page.items)).toEqual(PROBE_ROWS.map((row) => row.id));
  expect(queries[0].where).toBeUndefined();
});

// 授权条件只能由产出它的实现、针对同一个资源编译；无法解释的条件一律报错，不得退化为不过滤。
test("拒绝未注册资源、跨实现、跨资源与缺少载荷的条件", async () => {
  const { suite } = createHarness();
  const access = await suite.accessControl.createListConstraint({
    actor: ORG_A_MEMBER,
    action: "read",
    resource: ORGANIZATION_RESOURCE,
  });

  await expect(suite.authorizedQuery.list(listInput({ access, resourceType: "not-registered" }))).rejects.toThrow(
    "资源 not-registered 未注册存储绑定，无法解析归属范围",
  );
  await expect(
    suite.authorizedQuery.list(listInput({ access: { ...access, provider: "ee-access-control" } })),
  ).rejects.toThrow("授权条件由 ee-access-control 产出，不能由 access-control 编译");
  await expect(
    suite.authorizedQuery.list(listInput({ access: { ...access, resourceType: PERSONAL_RESOURCE_TYPE } })),
  ).rejects.toThrow(`授权条件属于资源 ${PERSONAL_RESOURCE_TYPE}，不能用于 ${ORGANIZATION_RESOURCE_TYPE}`);

  const { [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: _omitted, ...withoutPayload } = access;
  await expect(
    suite.authorizedQuery.list(listInput({ access: withoutPayload as ResourceQueryConstraint })),
  ).rejects.toThrow("授权条件缺少已解析的授权事实");
});
