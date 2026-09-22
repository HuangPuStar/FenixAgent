import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import * as schema from "../../db/schema";
import { getIdentityConfig } from "../config";
import { getIdentityDatabase } from "../db";
import { ensurePersonalOrganization } from "../services/personal-organization";
import { normalizeChineseMainlandPhoneNumber } from "../services/phone-number";
import { buildTrustedOrigins } from "./trusted-origins";

type AuthInstance = ReturnType<typeof buildAuth>;

/**
 * 构造 better-auth 实例。
 *
 * 不能放在模块顶层：它需要 `getDatabase()` 与 `getModuleConfig("identity")`，两者都只有宿主
 * 完成基础设施初始化后才可读取。顶层构造会让模块文件加载顺序变成隐式启动依赖。
 */
function buildAuth() {
  const config = getIdentityConfig();
  return betterAuth({
    // baseURL 用于生成回调/重定向 URL。线上必须通过 BETTER_AUTH_URL 环境变量设置。
    baseURL: config.betterAuthUrl,
    // secret 显式取自模块配置（`BETTER_AUTH_SECRET`），让密钥来源与其余字段一致、可被启动期校验兜住形状。
    // 未设置时它是 `undefined`，与不传等价：better-auth 内部仍按 `options.secret || env.BETTER_AUTH_SECRET
    // || env.AUTH_SECRET || 内置默认串` 回落（默认串在生产环境会被拒绝），本模块不代为补默认值。
    secret: config.betterAuthSecret,
    database: drizzleAdapter(getIdentityDatabase(), {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh once per day
    },
    trustedOrigins: buildTrustedOrigins({
      trustedOrigins: config.trustedOrigins,
      betterAuthUrl: config.betterAuthUrl,
      rcsBaseUrl: config.rcsBaseUrl,
    }),
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        membershipLimit: 100,
      }),
      phoneNumber({
        sendOTP: async () => {},
        phoneNumberValidator: async (value) => {
          try {
            normalizeChineseMainlandPhoneNumber(value);
            return true;
          } catch {
            return false;
          }
        },
      }),
      apiKey({
        defaultPrefix: "rcs_",
        enableMetadata: true,
        // 平台 API key 主要用于 External API / ACP relay，这类调用会高频校验；
        // better-auth 默认 10 次/天的限流过于激进，因此统一在服务端配置层关闭。
        rateLimit: {
          enabled: false,
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // 注册后立刻创建个人组织与 owner 成员关系（多租户不变量，见 services/personal-organization）。
          // 引导失败不能阻断注册本身，因此这里吞掉异常并记录：用户下次登录会落到"无组织"分支，
          // 由运维补齐，与迁移前的行为一致。
          after: async (user) => {
            try {
              await ensurePersonalOrganization(user);
            } catch (err) {
              console.error(err);
            }
          },
        },
      },
    },
  });
}

let authInstance: AuthInstance | undefined;

/**
 * 取得进程级 better-auth 实例。
 *
 * 单例必须与 better-auth 自身的假设一致：它内部持有 session/rate-limit 状态，构造两次会让
 * 同一进程出现两套互不可见的认证状态。
 */
export function getAuth(): AuthInstance {
  authInstance ??= buildAuth();
  return authInstance;
}

/** 清空 better-auth 单例，仅供测试在替换基础设施后重新构造。 */
export function resetAuth(): void {
  authInstance = undefined;
}
