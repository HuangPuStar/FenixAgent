import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { db } from "../db";
import * as schema from "../db/schema";
import { normalizeChineseMainlandPhoneNumber } from "../services/phone-number";
import { buildTrustedOrigins } from "./trusted-origins";

function generateId(size = 32): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: size }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export const auth = betterAuth({
  // baseURL 用于生成回调/重定向 URL。线上必须通过 BETTER_AUTH_URL 环境变量设置。
  baseURL: process.env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
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
    trustedOrigins: process.env.RCS_TRUSTED_ORIGINS,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    rcsBaseUrl: process.env.RCS_BASE_URL,
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
        after: async (user) => {
          try {
            const orgId = generateId();
            const slug = `personal-${user.id.slice(0, 8)}`;
            await db.insert(schema.organization).values({
              id: orgId,
              name: user.name,
              slug,
              createdAt: new Date(),
            });
            await db.insert(schema.member).values({
              id: generateId(),
              organizationId: orgId,
              userId: user.id,
              role: "owner",
              createdAt: new Date(),
            });
          } catch (err) {
            console.error(err);
          }
        },
      },
    },
  },
});
