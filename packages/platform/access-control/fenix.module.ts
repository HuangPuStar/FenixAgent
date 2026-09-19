import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * 授权模块的静态装配描述符。
 *
 * `dependsOn: ["identity"]` 表达"Identity 与 AccessControl 成套替换"的装配契约（工程标准 §2.3 的
 * 依赖矩阵与 EE 扩展架构的要求）：两者必须来自同一产品版本，profile 混用不匹配的组合在 preflight
 * 即失败。CE 的授权实现只消费已经解析好的 `ActorContext`（成员关系由身份层产出并全量带入），
 * 不读取身份表——这条边是装配约束，不是运行期数据依赖。
 *
 * 已知不足：`createDrizzleAccessControl` 需要宿主的 `database` 与全部资源绑定，而当前
 * `ModuleFactoryContext` 只提供 env 与已创建模块，无法表达这两者。任务 1.2 的 mcp 切换由宿主
 * 手工注入，本工厂因此先返回组合面而非实例；registry 驱动的组合根落地时必须改成接收
 * `{ database, bindings }` 的工厂，此处不使用占位实例，以免形成第二套装配路径。
 */
export const moduleManifest = {
  id: "access-control",
  kind: "access-control",
  dependsOn: ["identity"],
  capabilities: ["platform.access-control"],
  create: () => import("./src/suite"),
} satisfies ModuleManifest;
