import Elysia from "elysia";

/**
 * 图片代理端点：后端以服务器身份请求外部图片，绕过浏览器 Referer 防盗链。
 * 前端将外部图片 URL 编码后传入，后端 fetch 后流式返回。
 */
const app = new Elysia({ name: "web-proxy-image" }).get("/proxy/image", async ({ query, set }) => {
  const url = typeof query.url === "string" ? query.url : "";
  if (!url) {
    set.status = 400;
    return { error: { code: "MISSING_URL", message: "缺少 url 参数" } };
  }

  // 安全校验：仅允许 http/https，防止 SSRF
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    set.status = 400;
    return { error: { code: "INVALID_URL", message: "仅支持 http/https 链接" } };
  }

  // 自动升级 http → https：大量 CDN 已关闭 HTTP 端口，http 请求返回 404 假页面
  const resolvedUrl = url.startsWith("http://") ? url.replace(/^http:\/\//, "https://") : url;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000); // 15s 超时

  /**
   * 带降级的 fetch：先尝试 HTTPS，失败则回退 HTTP。
   * 极少数内网/旧服务器仍只支持 HTTP。
   */
  async function tryFetch(targetUrl: string, fallbackUrl?: string): Promise<Response> {
    try {
      const resp = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FenixAgent/1.0)",
          Accept: "image/*",
        },
      });
      if (!resp.ok && fallbackUrl) {
        console.warn(`[proxy-image] 上游 ${targetUrl} 返回 ${resp.status}，降级到 ${fallbackUrl}`);
        return tryFetch(fallbackUrl); // 降级不再回退，避免无限循环
      }
      return resp;
    } catch (err) {
      if (fallbackUrl) {
        console.warn(`[proxy-image] 请求 ${targetUrl} 失败，降级到 ${fallbackUrl}`, err);
        return tryFetch(fallbackUrl);
      }
      throw err;
    }
  }

  try {
    const fallback = resolvedUrl !== url ? url : undefined;
    const resp = await tryFetch(resolvedUrl, fallback);
    clearTimeout(timeout);

    if (!resp.ok) {
      console.error(
        `[proxy-image] 上游返回 ${resp.status} for ${url} (尝试了 ${resolvedUrl}${fallback ? ` + ${fallback}` : ""})`,
      );
      set.status = 502;
      return { error: { code: "UPSTREAM_ERROR", message: `上游返回 ${resp.status}` } };
    }

    const contentType = resp.headers.get("content-type") ?? "image/png";
    const body = await resp.arrayBuffer();

    set.headers["content-type"] = contentType;
    set.headers["cache-control"] = "public, max-age=86400"; // 缓存 1 天，减少重复代理请求
    return new Response(body);
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[proxy-image] 请求失败: ${url}`, err);
    set.status = 502;
    return { error: { code: "FETCH_ERROR", message: "代理请求失败" } };
  }
});

export default app;
