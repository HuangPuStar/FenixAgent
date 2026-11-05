import { recordRequestError } from "../logging/http-logger";
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
  let id: string;
  try {
    id = decodeURIComponent(target![1]!);
  } catch {
    return Response.json({ error: { code: "INVALID_REQUEST", message: "invalid resource ID" } }, { status: 400 });
  }
  return proxy
    .proxy(request, target?.[2] ?? "", serverMatch ? id : undefined, sandboxMatch ? id : undefined)
    .catch((error: unknown) => {
      recordRequestError(request, error);
      const proxyError = error instanceof ProxyError ? error : new ProxyError(502, "proxy request failed");
      return Response.json(
        { error: { code: proxyError.code, message: proxyError.message } },
        { status: proxyError.status },
      );
    });
}
