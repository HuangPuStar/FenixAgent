import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { db } from "../db";
import * as schema from "../db/schema";
import { buildTrustedOrigins } from "./trusted-origins";

function generateId(size = 32): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: size }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export const auth = betterAuth({
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
  baseURL: process.env.BETTER_AUTH_URL || process.env.RCS_BASE_URL || "http://localhost:3001",
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
    apiKey({
      defaultPrefix: "rcs_",
      enableMetadata: true,
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
