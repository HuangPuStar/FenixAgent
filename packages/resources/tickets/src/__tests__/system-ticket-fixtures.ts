/**
 * 平台管理面路由用例的共享装配（协议级请求构造 + 两个组织的种子）。
 *
 * 为什么集中一处：详情/修改/标签挂载（`system-ticket-detail.test.ts`）与目录/账本
 * （`system-ticket-support.test.ts`）两个文件共用同一套请求构造与身份替身——逐文件复制会让「带系统 key」「两个
 * 组织的坐标」这两件必须逐字一致的事各写一份，一处改了另一处就成了假绿。
 *
 * 与 `ticket-harness.ts` 的边界：那个文件持有领域服务的替身与模块槽位（`/web` 与 `/api/system` 两个面共用），
 * 本文件只在它之上加「管理面请求怎么发」这一层。
 */

import { stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import type { TicketHarness } from "./ticket-harness";
import { BINDING_A, BINDING_B, ORG_A, ORG_B, PROJECT_A, PROJECT_B, stubDirectory } from "./ticket-harness";

/** 用例注入的系统 key；守卫替身会真的比对它（缺失/错误一律 401）。 */
export const SYSTEM_KEY = "sys-key-ticket-detail";

/** 平台写路径的审计主体：系统托管租户的用户 ID（身份目录替身按它返回展示名）。 */
export const SYSTEM_USER = "user_system_admin";

/** 带系统 key 的请求；方法/体由调用方按需给。 */
export function systemRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${SYSTEM_KEY}` },
  });
}

/** 带系统 key 的 JSON 请求；`idempotencyKey` 缺席表示刻意不带该头（用例覆盖两个稳定 400）。 */
export function jsonRequest(path: string, method: string, body: unknown, idempotencyKey?: string): Request {
  return systemRequest(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

/** 两个组织的项目：仓库绑定与仓库名都不同，才能看出请求打到了哪一个组织。 */
export function seedTwoOrganizations(harness: TicketHarness): void {
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A, name: "alpha-repo" });
  harness.projectStore.seed({ id: PROJECT_B, organizationId: ORG_B, repositoryRef: BINDING_B, name: "beta-repo" });
  harness.indexStore.seed({ projectId: PROJECT_A, issueNumber: "7", title: "甲组织的工单" });
  harness.indexStore.seed({ projectId: PROJECT_B, issueNumber: "3", title: "乙组织的工单" });
}

/** 身份目录替身：一个组织成员（工单负责人与评论作者的展示名来源）+ 系统托管租户（写路径的审计主体）。 */
export function stubSystemIdentity(): void {
  stubDirectory({
    users: [{ id: "user_member", name: "张三" }],
    membersOf: { [ORG_A]: [{ userId: "user_member", name: "张三" }] },
  });
  stubIdentityDirectory({
    resolveSystemTenant: async () => ({
      organizationId: "org_admin",
      organizationSlug: "admin",
      userId: SYSTEM_USER,
      email: "admin@example.test",
    }),
  });
}

/** 项目的当前行（`seedTwoOrganizations` 之后必然存在）；用于就地改状态而不是再种一行。 */
export function projectRow(harness: TicketHarness, projectId: string) {
  const row = harness.projectStore.rows.find((candidate) => candidate.id === projectId);
  if (row === undefined) throw new Error(`用例未种项目 ${projectId}`);
  return row;
}
