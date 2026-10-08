/**
 * 从服务的配置值中抽取「可能是服务名」的引用（host 位置）。
 *
 * 为什么需要：Compose 无法表达跨项目依赖（写别项目的服务名会报 depends on undefined service），
 * 本仓的跨项目关系因此**只体现在值里**——`DATABASE_URL: ...@postgres:5432/...`、`S3_ENDPOINT: rustfs:9000`、
 * `RCS_URL: ws://rcs:3000`。这里只做「候选抽取」：是否真的指向某个 compose 服务，由 topology.ts
 * 用全局服务名索引判定，避免把 `dashscope.aliyuncs.com` 之类的外部域名也算进来。
 */

/** 一条引用候选：token 是 host 位置上的名字，value 是原始字符串，path 是它在服务里的位置。 */
export type ServiceReference = {
  token: string;
  path: string;
  value: string;
  /** 该引用在 compose 文件里的行号（1 起；定位不到时为 0） */
  line: number;
};

/** scheme:// 之后到路径之前的部分，取其 host（去掉 userinfo 与端口）。 */
const URL_RE = /[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\s'"]+)/g;
/** 值里裸写的 `host:port`（DSN、endpoint 常见形态）。 */
const HOST_PORT_RE = /\b([a-z][a-z0-9_-]*):(\d{2,5})\b/g;
/** 纯主机名形态（仅用于 `*_HOST: mysql` 这类带键名的位置，不做全文匹配）。 */
const BARE_HOST_RE = /^[a-z][a-z0-9-]*$/;

/** 需要抽取引用的字段（值是字符串或字符串数组）；其余字段不进候选，减少噪声。 */
const SCAN_KEYS = new Set(["environment", "command", "entrypoint", "healthcheck"]);

type Leaf = { path: string; value: string };

/** 递归收集字段里的字符串叶子，路径用于在 UI 里指认证据（如 `environment.DATABASE_URL`）。 */
function collectLeaves(value: unknown, path: string, out: Leaf[], depth = 0): void {
  if (depth > 6 || out.length > 400) return;
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push({ path, value: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeaves(item, `${path}[${index}]`, out, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      // healthcheck 只关心 test，其余字段（interval/retries）没有地址信息。
      if (path === "healthcheck" && key !== "test") continue;
      const childPath = path === "environment" && Array.isArray(value) ? path : `${path}.${key}`;
      collectLeaves(child, childPath, out, depth + 1);
    }
  }
}

/**
 * 从单个字符串值里抽出所有 host 候选。
 *
 * keyHint 是值所在的字段名（如 `PGHOST`、`S3_ENDPOINT`）：只有形如 host/url/endpoint 的字段
 * 才接受「裸主机名」这种弱证据。原因：`PGUSER: rcs`、`command: [opensandbox-server, ...]` 里也会
 * 出现与某个服务同名的普通字符串，全文匹配会凭空造出不存在的依赖边。
 */
export function extractHostTokens(value: string, keyHint = ""): string[] {
  const tokens = new Set<string>();
  const trimmed = value.trim();
  const hostLikeKey = /host|url|endpoint|addr|address|server|broker|registry|dsn|gateway/i.test(keyHint);

  for (const match of trimmed.matchAll(URL_RE)) {
    const authority = match[1];
    const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
    const host = hostPart.split(/[/?#]/)[0].split(":")[0];
    if (host && BARE_HOST_RE.test(host)) tokens.add(host);
  }

  for (const match of trimmed.matchAll(HOST_PORT_RE)) {
    if (BARE_HOST_RE.test(match[1])) tokens.add(match[1]);
  }

  // `PGHOST: postgres`（字段名给线索）与 `host=mysql`（值内自带线索）两种裸主机名写法。
  if (hostLikeKey && BARE_HOST_RE.test(trimmed)) tokens.add(trimmed);
  for (const piece of trimmed.split(/[;,\s]+/)) {
    const [key, raw] = piece.split("=");
    if (raw === undefined) continue;
    if (!/host|url|endpoint|addr|address|server|broker|registry|dsn/i.test(key)) continue;
    const host = raw.trim().split(":")[0];
    if (BARE_HOST_RE.test(host)) tokens.add(host);
  }

  return [...tokens];
}

/** 取路径最后一段作为字段名线索：`environment.PGHOST` → `PGHOST`，`command[1]` → `command`。 */
export function keyHintOf(path: string): string {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[\d+\]/g, "");
}

/** 抽取入口：只扫白名单字段，返回去重后的候选（行号留待 resolveReferenceLines 补齐）。 */
export function collectServiceReferences(service: Record<string, unknown>): Array<Omit<ServiceReference, "line">> {
  const leaves: Leaf[] = [];
  for (const [key, value] of Object.entries(service)) {
    if (!SCAN_KEYS.has(key)) continue;
    collectLeaves(value, key, leaves);
  }

  const seen = new Set<string>();
  const refs: Array<Omit<ServiceReference, "line">> = [];
  for (const leaf of leaves) {
    for (const token of extractHostTokens(leaf.value, keyHintOf(leaf.path))) {
      const dedupeKey = `${token}|${leaf.path}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      refs.push({ token, path: leaf.path, value: leaf.value });
      if (refs.length >= 12) return refs;
    }
  }
  return refs;
}

/**
 * 在服务的文本块内定位引用的行号：先找同时含字段名与 token 的行（更精确），再退回只含 token 的行。
 * 找不到时返回 0——UI 会退化为「跳到服务块起始行」，不影响可用性。
 */
export function resolveReferenceLines(
  lines: string[],
  block: { start: number; end: number },
  refs: Array<Omit<ServiceReference, "line">>,
): ServiceReference[] {
  return refs.map((ref) => {
    // environment 的列表写法（`- PGHOST=postgres`）里，字段名在值里而不是路径里。
    const inlineKey = /^([A-Z0-9_]+)=/.exec(ref.value)?.[1];
    const keyHint = inlineKey ?? keyHintOf(ref.path);
    let fallback = 0;
    for (let line = block.start; line <= block.end && line <= lines.length; line += 1) {
      const text = lines[line - 1] ?? "";
      if (!text.includes(ref.token)) continue;
      if (text.includes(keyHint)) return { ...ref, line };
      if (fallback === 0) fallback = line;
    }
    return { ...ref, line: fallback || block.start };
  });
}
