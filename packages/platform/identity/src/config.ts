import { getModuleConfig } from "@fenix/platform-sdk/server";

/**
 * 身份模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已经解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源）。
 * 模块自身不读 `process.env`、不读 `.env`：包内出现第二份环境解析会让"同一变量两处默认值"
 * 这类分歧无法在启动期暴露。
 *
 * 这些字段仍由宿主直接提供（`bootstrap/module-configs.ts` 投影），而不是从模块 `envDefinitions` 的解析结果里取：
 * 1.7 C 块路线 A 下 `envDefinitions` 只承担启动期校验与汇总，值的传递仍走模块配置这一条既有通道。
 */
export interface IdentityConfig {
  /** better-auth 的 baseURL，用于生成回调与重定向 URL。线上必须显式配置。 */
  readonly betterAuthUrl?: string;
  /**
   * better-auth 的签名/加密密钥材料（`BETTER_AUTH_SECRET`）。
   *
   * 可选语义必须保留：未设置时 better-auth 自行回落（`options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET`，
   * 再退到内置默认串，生产环境用默认串会直接抛错）。因此传 `undefined` 与不传等价——本模块不替它造默认值。
   */
  readonly betterAuthSecret?: string;
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
