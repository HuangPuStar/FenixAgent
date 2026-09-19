import { getModuleConfig } from "@fenix/platform-sdk/server";

/**
 * 身份模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已经解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源）。
 * 模块自身不读 `process.env`、不读 `.env`：包内出现第二份环境解析会让"同一变量两处默认值"
 * 这类分歧无法在启动期暴露。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`：1.2 只负责把职责搬到正确的包，
 * env 的声明、校验与 preflight 收敛在 1.7 统一处理。
 */
export interface IdentityConfig {
  /** better-auth 的 baseURL，用于生成回调与重定向 URL。线上必须显式配置。 */
  readonly betterAuthUrl?: string;
  /** 对外服务基址，参与 trustedOrigins 推导。 */
  readonly rcsBaseUrl?: string;
  /** 逗号分隔的额外可信来源。 */
  readonly trustedOrigins?: string;
  /** 系统管理员密码文件路径；`ensureSystemAdmin` 用它做首次启动引导。 */
  readonly systemAdminPasswordFile: string;
  /** 关闭公开注册；关闭后只有系统管理接口能创建用户。 */
  readonly disableSignup?: boolean;
}

/** 读取身份模块的已校验配置。 */
export function getIdentityConfig(): IdentityConfig {
  return getModuleConfig<IdentityConfig>("identity");
}
