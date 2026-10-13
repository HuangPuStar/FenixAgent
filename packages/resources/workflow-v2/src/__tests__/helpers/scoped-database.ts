// __tests__/helpers/scoped-database.ts
// 用例的「台账读取作用域」：把平台账号台账（`workflow_v2_platform_account`）的**读**收进某个测试前缀。
//
// 为什么需要（真实事故）：台账是**全局单行**表，生产读路径按 `created_at` 升序取全表首行
// （`platform-account-bootstrap.findPlatformAccountRow` 与 `tenant-binding-repository.findTenantBinding`），
// **没有前缀/组织维度的过滤**——这是对的（它描述的是部署级事实）。代价是本机主库里只要存在任何一行真实台账
// （真实部署登录留下的），未加作用域的用例就会：
// ① **被顶掉归属**：真实行若比用例种下的行更早，就会被当成「本组织的账号」，`space_id` 断言、绑定判定与按需
//    引导全部跑偏（实测：一行 `created_at = epoch` 的探针行足以让发布与注册表用例集体失败）；
// ② **改写真实数据**：引导路径在「已存在行」分支按主键更新该行并写入新的 `platform_user_id`
//    （`platform-account-bootstrap` 的身份改写），于是真实行的身份被改成测试前缀的值，随后被该文件的
//    「按前缀清理」**删掉**——真实行就这样消失了（实测复现：`org-app-binding.test.ts` 单独跑一次即删掉探针行）。
//
// 做法：包一层**只读作用域**——只给台账的 `select` 追加前缀过滤，其余表与其余语句（含所有写语句）原样转发。
// 于是「本用例看到的台账」只由本用例自己写的行构成：既不会被真实行顶掉，也不可能改写/删除真实行；引导成功后
// 应用自己写的行（带测试前缀）照常可见，链路仍然真实。
//
// 使用口径：**凡是把真实 Postgres 句柄注入应用基础设施的用例，都应经本函数注入**
// （`console-plane-harness.ts` 与 `org-app-binding.test.ts` 的默认注入即此）。用内存替身的用例不需要它。

import { workflowV2PlatformAccount } from "@fenix/resource-workflow-v2/db";
import { like } from "drizzle-orm";

/**
 * 生成「台账读只看 `prefix` 前缀行」的数据库句柄。
 *
 * @param handle 真实的 Drizzle 句柄（写语句原样落到它指向的库）。
 * @param prefix 本文件的测试数据前缀（如 `wf2-test-` / `wf2-app-test-`）；台账读据此收窄。
 */
export function createTestScopedDatabase(handle: unknown, prefix: string): unknown {
  const real = handle as Record<PropertyKey, unknown>;
  const prefixFilter = like(workflowV2PlatformAccount.platformUserId, `${prefix}%`);

  /** 包住 `select()` 的返回值：`from(台账)` 时补一条前缀过滤，其余情况原样返回。 */
  const scopeSelect = (builder: unknown): unknown =>
    new Proxy(builder as object, {
      get(target, property, receiver) {
        if (property === "from") {
          const from = Reflect.get(target, "from", receiver) as (table: unknown, ...rest: unknown[]) => unknown;
          return (table: unknown, ...rest: unknown[]) => {
            const next = from.call(target, table, ...rest);
            if (table !== workflowV2PlatformAccount) return next;
            return (next as { where: (condition: unknown) => unknown }).where(prefixFilter);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return new Proxy(real as object, {
    get(target, property, receiver) {
      if (property === "select") {
        const select = Reflect.get(target, "select", receiver) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => scopeSelect(select.call(target, ...args));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
