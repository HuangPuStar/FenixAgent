import Elysia from "elysia";
import { auth } from "../auth/better-auth";
import { config } from "../config";
import { validateLegacyApiKey } from "../auth/api-key-service";
import { verifyWorkerJwt } from "../auth/jwt";

interface UserInfo {
  id: string;
  email: string;
  name: string;
}

interface AuthSessionInfo {
  id: string;
  userId: string;
  token: string;
}

function extractToken(request: Request): string | undefined {
  const authHeader = request.headers.get("Authorization");
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  return authHeader?.replace("Bearer ", "") || queryToken || undefined;
}

export async function ensureSystemUser(): Promise<UserInfo | null> {
  const { db } = await import("../db");
  const { user } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");

  const rows = await db.select().from(user).where(eq(user.email, "system@rcs.local")).limit(1);
  if (rows.length > 0) {
    return { id: rows[0].id, email: rows[0].email, name: rows[0].name };
  }

  const anyUser = await db.select().from(user).limit(1);
  if (anyUser.length > 0) {
    return { id: anyUser[0].id, email: anyUser[0].email, name: anyUser[0].name };
  }

  try {
    const result = await (auth.api.signUpEmail as any)({
      email: "system@rcs.local",
      password: "system",
      name: "System",
    });
    if (result.user) {
      const { createApiKey } = await import("../auth/api-key-service");
      await createApiKey(result.user.id, "legacy-auto");
      return { id: result.user.id, email: result.user.email, name: result.user.name };
    }
  } catch {
    // signUpEmail may fail if user was created concurrently
  }

  return null;
}

export async function lookupUserById(userId: string): Promise<UserInfo | null> {
  const { db } = await import("../db");
  const { user } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  return row ? { id: row.id, email: row.email, name: row.name } : null;
}

/** Mounts better-auth handler at /api/auth/* */
export const authPlugin = new Elysia({ name: "auth", prefix: "/api/auth" }).all(
  "/*",
  ({ request }) => auth.handler(request)
);

/** Provides `error(code, body)` to route handler context */
export function errorResponse(code: number, response: unknown): Response {
  return new Response(JSON.stringify(response), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

/** Auth guard macros + state for route-level authentication */
export const authGuardPlugin = new Elysia({ name: "auth-guard" })
  .decorate({ error: errorResponse })
  .state({
    user: null as UserInfo | null,
    authSession: null as AuthSessionInfo | null,
    authEnvironmentId: null as string | null,
    uuid: null as string | null,
  })
  .macro({
    sessionAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: async ({ store, request, error }: any) => {
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session?.user) {
            return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
          }
          store.user = { id: session.user.id, email: session.user.email, name: session.user.name };
          store.authSession = {
            id: session.session.id,
            userId: session.session.userId,
            token: session.session.token,
          };
        },
      };
    },
    apiKeyAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: async ({ store, request, error }: any) => {
          const token = extractToken(request);
          if (!token) {
            return error(401, { error: { type: "unauthorized", message: "Missing API key" } });
          }

          // 0. Environment secret match
          const { environmentRepo } = await import("../repositories");
          const envRecord = await environmentRepo.getBySecret(token);
          if (envRecord && envRecord.userId) {
            const user = await lookupUserById(envRecord.userId);
            if (user) {
              store.user = user;
              store.authEnvironmentId = envRecord.id;
              return;
            }
          }

          // 1. Per-user API Key
          const { validateApiKeyAndGetUser } = await import("../auth/api-key-service");
          const result = await validateApiKeyAndGetUser(token);
          if (result) {
            const user = await lookupUserById(result.userId);
            if (user) {
              store.user = user;
              return;
            }
          }

          // 2. Legacy global API Key
          if (config.apiKeys.length > 0 && config.apiKeys.includes(token)) {
            const systemUser = await ensureSystemUser();
            if (systemUser) {
              store.user = systemUser;
              return;
            }
          }

          return error(401, { error: { type: "unauthorized", message: "Invalid API key" } });
        },
      };
    },
    uuidAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: ({ store, request, error }: any) => {
          const url = new URL(request.url);
          const uuid = url.searchParams.get("uuid");
          if (!uuid) {
            return error(401, { error: { type: "unauthorized", message: "Missing uuid" } });
          }
          store.uuid = uuid;
        },
      };
    },
    sessionIngressAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: async ({ store, request, error }: any) => {
          const token = extractToken(request);

          // Try legacy API key
          if (validateLegacyApiKey(token)) {
            const systemUser = await ensureSystemUser();
            if (systemUser) {
              store.user = systemUser;
              return;
            }
          }

          // Try worker JWT
          if (token) {
            const payload = verifyWorkerJwt(token);
            if (payload) {
              return;
            }
          }

          return error(401, { error: { type: "unauthorized", message: "Invalid auth" } });
        },
      };
    },
  });
