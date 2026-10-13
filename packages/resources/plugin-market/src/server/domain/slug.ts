/**
 * 包名的 URL 安全可逆编码（slug）。
 *
 * 为什么不直接用包名：scoped 包名含 `/`（`@acme/team`），放进路径段会被拆成两段；而依赖 `%2F` 也不可靠
 * ——不同反向代理对编码斜杠的处理不一致。base64url 的字符集里没有任何保留字符，因此 slug 永远不会被
 * 误当作路径分隔符。也刻意不做「可读化」的改写：scope 分隔符与大小写都是 NPM 身份的一部分，改写会让
 * 两个不同的包塌缩成同一个 slug。
 */

/** 前缀把 slug 与包名本身区分开，也给了「这不是 slug」一个显式的否定答案。 */
const SLUG_PREFIX = "p-";

/** base64url 字符集；用它反过来约束输入，可以拒绝填充符、控制字符与路径穿越形状的键。 */
const SLUG_BODY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 把包名编码成 slug。 */
export function toPackageSlug(packageName: string): string {
  return `${SLUG_PREFIX}${Buffer.from(packageName, "utf8").toString("base64url")}`;
}

/**
 * 解码 slug；**只接受规范编码**。
 *
 * 非规范输入（填充符、多余字符、另一种字节序列）一律返回 null：这样 `p-..%2F` 一类形状的键在任何查询
 * 发生之前就被否掉，而「同一个包只有一个 slug」也让缓存键与路由键一致。
 */
export function fromPackageSlug(slug: string): string | null {
  if (typeof slug !== "string" || !slug.startsWith(SLUG_PREFIX)) return null;
  const body = slug.slice(SLUG_PREFIX.length);
  if (!SLUG_BODY_PATTERN.test(body)) return null;
  const decoded = Buffer.from(body, "base64url").toString("utf8");
  if (decoded.length === 0) return null;
  return toPackageSlug(decoded) === slug ? decoded : null;
}
