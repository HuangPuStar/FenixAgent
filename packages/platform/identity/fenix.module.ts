import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Identity 平台模块描述符。
 *
 * 身份、组织、成员、认证与 API Key 的唯一 owner。它是平台基础模块：不依赖任何其他模块
 * （`dependsOn` 为空），资源与运行时模块也**不得**直接依赖它——依赖矩阵禁止任何类别依赖
 * `platform-impl`。调用方需要的身份数据只经 `@fenix/platform-sdk` 的 `IdentityDirectory`
 * 窄契约取得，由宿主 `apps/server` 注册实现。
 *
 * 本模块声明的运行期依赖只有应用基础设施中的 DB（经 `@fenix/platform-sdk/server` 读取）；
 * better-auth 与系统管理员密码文件等部署配置当前仍由宿主解析后经 `initializeApplicationInfrastructure`
 * 的模块配置传入，模块自身的 `envDefinitions` 与 preflight 随 1.7 的 env 收敛一并补齐。
 */
export const moduleManifest = {
  id: "identity",
  kind: "identity",
  dependsOn: [],
  capabilities: ["platform.identity"],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle 与 better-auth 拖进模块图。
  create: () => import("./src/module").then((module) => module.createIdentityModule()),
} satisfies ModuleManifest;
