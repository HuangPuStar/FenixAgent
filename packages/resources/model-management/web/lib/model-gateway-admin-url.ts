/** Browser navigation must not send a remote administrator to the server's loopback address. */
export function browserAdminUiUrl(configuredUrl: string | null | undefined, browserHostname: string): string | null {
  if (!configuredUrl || !URL.canParse(configuredUrl)) return null;
  const url = new URL(configuredUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const loopback = (hostname: string) =>
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127\./.test(hostname);
  if (["0.0.0.0", "[::]"].includes(url.hostname) || (loopback(url.hostname) && !loopback(browserHostname))) return null;
  return url.href;
}
