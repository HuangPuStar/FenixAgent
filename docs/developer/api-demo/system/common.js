/**
 * 校验必须的环境变量，缺失时给出可执行报错。
 */
export function requireValue(name, value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`Missing required config: ${name}`);
}

/**
 * 输出清晰的阶段标题，便于观察 demo 执行过程。
 */
export function logSection(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * 将相对 API 路径解析成完整 URL。
 */
export function toAbsoluteUrl(baseUrl, path) {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  return new URL(path, `${baseUrl}/`).toString();
}

/**
 * 创建带 system Bearer Token 的简单 API 客户端。
 */
export function createSystemApiClient(config) {
  return {
    async request(path, init = {}) {
      const systemApiKey = requireValue("systemApiKey", config.systemApiKey);
      const headers = new Headers(init.headers ?? {});
      headers.set("Authorization", `Bearer ${systemApiKey}`);

      const response = await fetch(toAbsoluteUrl(config.baseUrl, path), {
        ...init,
        headers,
      });

      const rawText = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json") && rawText ? JSON.parse(rawText) : rawText;

      if (!response.ok) {
        const message =
          typeof data === "object" && data && "error" in data
            ? (data.error?.message ?? JSON.stringify(data))
            : rawText || response.statusText;
        throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${message}`);
      }

      return data;
    },
  };
}
