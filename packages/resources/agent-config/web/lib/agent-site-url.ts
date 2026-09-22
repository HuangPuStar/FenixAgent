/**
 * agent-site-url.ts — 站点同源部署地址（`/web/site/deploy/<appId>/`）的唯一拼装口径。
 *
 * 这条规则原先在包内写了三份：聊天卡片 `components/agent-panel/AgentSitesCard.tsx`（iframe 预览）、
 * 站点外壳 `components/agent-panel/SiteFrame.tsx`（iframe + 新窗口 + 分享二维码）、目录页
 * `pages/agent-panel/pages/agent-sites-catalog.tsx`（`<a href>`）。三处的路径前缀与目标语义完全相同，
 * 但只有目录页对 appId 做了 `encodeURIComponent`，另外两处裸拼——即同一个 `remoteAppId` 存在两种编码
 * 口径。收敛到本模块后，前缀与编码规则只此一份。
 *
 * **编码口径：整段 `encodeURIComponent`**
 *   - `/` 必须编码。它是路径段边界：裸拼会把一段 id 拆成多段（`/web/site/deploy/a/b/` 落到
 *     `/web/site/deploy/:appId/*` 的深层路径上），同时也是路径穿越面；
 *   - `#` / `?` 必须编码。URL 解析器把它们当作 fragment / query 的起点，裸拼会让 iframe `src`、
 *     `window.open`、`<a href>` 打开到错误地址（尾斜杠与后续站内路径一并丢失）；
 *   - `%` 必须编码。裸拼的 `%xx` 会被解析器与服务端当成转义序列，decode 后与 DB 里的字面值不再相等；
 *   - 空格 / 中文等非 ASCII：编码与否在浏览器里**等价**（URL 解析器会自行 percent-encode），
 *     统一编码是为了口径唯一，不是为了修这一类字符——三者对它们的实际行为本来就一致。
 *
 * **三个调用场景对地址的要求一致**：同源绝对路径、单段 appId、保留尾斜杠（站点是目录式部署，
 * 站内相对资源依赖尾斜杠解析）。没有任何场景需要「保留未编码形态」（不需要把 appId 当 query 传，
 * 也不需要 `#` 的 fragment 语义），这正是三处可以合并成一份的依据。
 *
 * **已知边界**：`encodeURIComponent` 不编码 `.`，因此纯点段（`..`）仍会被 URL 解析器按相对路径归一化
 * （`/web/site/deploy/../` → `/web/site/`）。本模块不额外拦截：拦截只能靠抛错或返回哨兵值，会给三个
 * 调用点引入新的失败分支；而 `remoteAppId` 由平台 `POST /api/apps` 生成（`RemoteApp.id`，形如
 * `app-91a0621c`），`web/api/sites.ts` 的 `SiteCreateBody` 没有任何用户输入写入该字段，点段不可达。
 */

/** 站点部署路径前缀。调用方不要再写字面量——改前缀只应改这里。 */
const AGENT_SITE_DEPLOY_PREFIX = "/web/site/deploy/";

/**
 * 站点同源部署地址：`/web/site/deploy/<encodeURIComponent(remoteAppId)>/`。
 *
 * 返回值恒以 `/` 开头（从域根解析，不受当前页面路径影响）并以 `/` 结尾（目录式部署）。`remoteAppId`
 * 非空由调用方保证：空值该「不渲染」还是「报错」是各调用点的语义，不在这里替它们决定。
 */
export function buildAgentSiteUrl(remoteAppId: string): string {
  return `${AGENT_SITE_DEPLOY_PREFIX}${encodeURIComponent(remoteAppId)}/`;
}

/**
 * 站点对外可分享的绝对地址：`origin` + 同源部署路径（SiteFrame 的分享二维码用）。
 *
 * `relativeUrl` 必须是以 `/` 开头的同源路径（本模块只产这种形态），`origin` 传 `window.location.origin`。
 * 少了前导斜杠会让地址相对当前页面解析，二维码就指向当前页面的子路径而不是站点——这条约束写在这里，
 * 是为了让「绝对地址 = origin + 同源路径」也只有一份定义。
 */
export function buildAgentSiteAbsoluteUrl(relativeUrl: string, origin: string): string {
  return `${origin}${relativeUrl}`;
}
