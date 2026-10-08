import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { generatedWebContributionEntries } from "../../../generated/web-contributions";

/** 带 manifest 身份的浏览器贡献；运行期不得扩展此集合。 */
export interface AssemblyWebEntry {
  readonly id: string;
  readonly contribution: WebAppContribution;
}

/** undefined 表示清单不可用，按构建期上界 fail-open；空数组表示全部关闭。 */
export function enabledWebIds(
  web: readonly string[] | undefined,
  entries: readonly AssemblyWebEntry[] = generatedWebContributionEntries,
): ReadonlySet<string> {
  return new Set(entries.filter((entry) => web === undefined || web.includes(entry.id)).map((entry) => entry.id));
}

/** 把装配裁剪转换成既有导航隐藏键，不改变 hiddenTabs 的偏好语义。 */
export function assemblyHiddenTabs(
  enabled: ReadonlySet<string>,
  entries: readonly AssemblyWebEntry[] = generatedWebContributionEntries,
): string[] {
  return entries.flatMap((entry) =>
    enabled.has(entry.id) ? [] : (entry.contribution.navigation ?? []).map((item) => item.id),
  );
}

/** 按完整路径段匹配，避免 workflow-other 被 workflow 误拦；最长匹配允许嵌套入口独立归属。 */
export function routeWebId(
  pathname: string,
  entries: readonly AssemblyWebEntry[] = generatedWebContributionEntries,
): string | undefined {
  const path = pathname.replace(/^\/ctrl(?=\/|$)/, "") || "/";
  let owner: string | undefined;
  let matchedLength = 0;
  for (const entry of entries) {
    const prefixes = [
      ...(entry.contribution.navigation ?? []).map((item) => `/agent/${item.id}`),
      ...(entry.contribution.routePrefixes ?? []),
    ];
    for (const prefix of prefixes) {
      if ((path === prefix || path.startsWith(`${prefix}/`)) && prefix.length > matchedLength) {
        owner = entry.id;
        matchedLength = prefix.length;
      }
    }
  }
  return owner;
}
