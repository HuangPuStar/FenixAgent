// packages/web-runtime/web/lib/active-org.ts
// 「当前激活组织 id」的**唯一读取契约点**（前端规范 §3.3 / §8.1）。
//
// 为什么要有这个模块：组织身份只有两种合法读法（`useOrgSession()` / `useOrg()`，§3.3），
// 但实时通道两处都取不到上下文——WS 握手**无法携带自定义头**，组织参数只能进 URL query，
// 而拼 URL 的时机不在 React 渲染期（`buildYjsUrl` 在 hook 的建连 effect 里，
// `/web/file-events` 在宿主域模块的建连函数里）；身份包的 fetch 拦截器本身同样在 React 之外
// （它 monkey-patch `window.fetch`）。收敛前这两处各自 `localStorage.getItem("active_org_id")`，
// 那是「绕过上下文读取组织身份」的直读形态，且键字面量在 `OrgContext.tsx` 里另有一份。
//
// 本模块只做一件事：把**键**与**读取动作**各收敛成一份。写入语义（乐观写 + 失败回滚 + 切换后
// replace 导航）仍完整留在身份包的 `switchOrg` / `refreshOrgs`——本模块不是第二份组织真相，
// 它是身份域持久化结果的一个只读投影，且**不得被任何 HTTP 域模块或组件使用**（它们必须走
// `useOrgSession()`，或直接依赖 `X-Active-Org-Id` 注入，见 §3.3）。
//
// 影响面（必须知道的代价）：读到的是「最近一次本地写入」，而不是服务端确认后的值。
// §3.6 记录的「组织切换不是原子转换：`localStorage` 先于服务端确认写入」在这里被放大为
// 「切换瞬间建立的实时连接可能带旧组织 id」。现有的收敛手段是切换成功后 `switchOrg` 的
// `navigate({ to: "/agent/home", replace: true })` 会重建组件并重建连接（§3.3）。
//
// 移除条件：服务端能在握手期自行推导当前组织（如从 better-auth 会话取 activeOrganizationId，
// 不再依赖客户端在 query 里携带）后，删除本模块、两条通道 URL 中的组织参数，以及
// `OrgContext.tsx` 对它的引用。

/** 激活组织 id 的持久化键。跨包共享的运行时契约，必须与身份包的写入点逐字一致。 */
export const ACTIVE_ORG_STORAGE_KEY = "active_org_id";

/**
 * 读取持久化的激活组织 id；未设置或非浏览器环境返回 `null`。
 *
 * **唯一允许的调用方**：身份包的 fetch 拦截器（`X-Active-Org-Id` 注入）与两条实时通道的
 * URL 拼装（`agent-runtime/web/yjs/yjs-ws.ts`、宿主 `api/file-events.ts`）。
 * 新增调用方必须先改 §3.3 的白名单，而不是在本模块外再写一次 `localStorage.getItem`。
 */
export function readActiveOrgId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
}
