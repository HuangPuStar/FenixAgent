import type { ModuleManifest } from "@fenix/platform-sdk";
import { getDatabase } from "@fenix/platform-sdk/server";
import type { AccessControlDatabase } from "./src/database";

/**
 * 授权模块的静态装配描述符。
 *
 * `dependsOn: ["identity"]` 表达"Identity 与 AccessControl 成套替换"的装配契约（工程标准 §2.3 的
 * 依赖矩阵与 EE 扩展架构的要求）：两者必须来自同一产品版本，profile 混用不匹配的组合在 preflight
 * 即失败。CE 的授权实现只消费已经解析好的 `ActorContext`（成员关系由身份层产出并全量带入），
 * 不读取身份表——这条边是装配约束，不是运行期数据依赖。
 *
 * 工厂产出**真实例**（`DrizzleAccessControlSuite` 的三个授权端口），不再返回包命名空间：
 *
 * - `database` 经 `@fenix/platform-sdk/server` 的 `getDatabase()` 读取——进程级 DB client 的真相来源
 *   是宿主，包不得自建连接（同 1.4 在 agent-runtime 上验证过的模式）；
 * - 资源绑定经由 `context.declarations` 收集各资源模块声明的 `accessControlBindings`。绑定是**静态**
 *   导出，所以在授权模块构造期收集它们不会与「资源模块依赖授权能力」构成装配环，本模块的 `dependsOn`
 *   因此不必（也不得）写上那四个资源模块；
 * - 声明了绑定的资源模块只有在本 profile 启用时才会被收集：未启用的资源不注册，其查询会直接报错，
 *   而不是落到「没有归属列」的放宽查询上。
 */
export const moduleManifest = {
  id: "access-control",
  kind: "access-control",
  dependsOn: ["identity"],
  capabilities: ["platform.access-control"],
  create: (context) =>
    import("./src/suite").then((suite) =>
      suite.createDrizzleAccessControl({
        database: getDatabase<AccessControlDatabase>(),
        bindings: context.declarations.flatMap((manifest) => manifest.accessControlBindings ?? []),
      }),
    ),
} satisfies ModuleManifest;
