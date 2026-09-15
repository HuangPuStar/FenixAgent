import Elysia from "elysia";

function extractSystemToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  const url = new URL(request.url);
  return url.searchParams.get("token");
}

function getSystemApiKeys(): string[] {
  return (process.env.RCS_SYSTEM_API_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * 系统级 API 仅接受全局系统 key。
 * 该插件故意不恢复用户/组织上下文，避免与现有多租户 API 身份模型混淆。
 */
export const systemApiAuthPlugin = new Elysia({ name: "system-api-auth" })
  .decorate({
    error(code: number, response: unknown) {
      return new Response(JSON.stringify(response), {
        status: code,
        headers: { "Content-Type": "application/json" },
      });
    },
  })
  .state({
    systemAuth: null,
  } as { systemAuth: { token: string } | null })
  .macro({
    systemApiKeyAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        // biome-ignore lint/suspicious/noExplicitAny: Elysia macro context type not fully expressible
        beforeHandle: ({ store, request, error }: any) => {
          const token = extractSystemToken(request);
          const allowedKeys = getSystemApiKeys();

          // 显式要求配置系统 key，避免接口在未配置时被误开放。
          if (!token || allowedKeys.length === 0 || !allowedKeys.includes(token)) {
            return error(401, { error: { code: "UNAUTHORIZED", message: "Invalid system API key" } });
          }

          store.systemAuth = { token };
        },
      };
    },
  });
