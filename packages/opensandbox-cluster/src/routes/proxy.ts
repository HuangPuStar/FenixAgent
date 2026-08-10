import { isValidClusterApiKey } from "../security/api-auth";
import { ProxyError, type ProxyService } from "../services/proxy-service";
import type { ClusterConfig } from "../types";

export function handleProxyRequest(
  config: ClusterConfig,
  proxy: ProxyService,
  request: Request,
  set: { status?: number | string },
) {
  const pathname = new URL(request.url).pathname;
  const serverMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/proxy\/?(.*)$/);
  const sandboxMatch = pathname.match(/^\/api\/v1\/sandboxes\/([^/]+)\/proxy\/?(.*)$/);
  if (!serverMatch && !sandboxMatch) return;
  if (!isValidClusterApiKey(request, config)) {
    set.status = 401;
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "invalid cluster service credentials" } },
      { status: 401 },
    );
  }
  const target = serverMatch ?? sandboxMatch;
  return proxy
    .proxy(
      request,
      target?.[2] ?? "",
      serverMatch ? serverMatch[1] : undefined,
      sandboxMatch ? sandboxMatch[1] : undefined,
    )
    .catch((error: unknown) => {
      const proxyError = error instanceof ProxyError ? error : new ProxyError(502, "proxy request failed");
      return Response.json(
        { error: { code: "PROXY_ERROR", message: proxyError.message } },
        { status: proxyError.status },
      );
    });
}
