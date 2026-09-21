/**
 * Identity 的浏览器安全入口。
 *
 * 身份与组织的前端能力（better-auth 客户端、组织上下文、密码加密、页面与领域 API client）只在
 * `@fenix/identity/web` 暴露；服务端实现必须继续从 `@fenix/identity/server` 导入。任何在此新增的
 * 导出都必须不依赖 `node:`、不读 `process.env`，否则会污染浏览器 bundle。
 *
 * 该入口是控制台壳装配身份页面的唯一公开面：`apps/web` 的 Shell 与路由只从此处取用身份页面、
 * provider 与 API client，不得直接进入包内文件路径。
 *
 * 组织页需要机器注册表能力（机器列表、预注册、改删）。§2.3 禁止 platform 实现依赖 `resources`，
 * 因此该能力以 `MachineRegistryPort` 的形式由宿主注入：`AgentOrganizationsPage` 的
 * `machineRegistry` prop 由 route adapter 传入 `@fenix/resource-machine/web` 的 `registryApi`，
 * 端口形状与字段漂移的约束见 `agent-organizations-types.ts`。
 */

export * from "./api/api-keys";
export * from "./api/organizations";
export { ChangePasswordDialog } from "./components/ChangePasswordDialog";
export { OrgProvider, useOrg } from "./contexts/OrgContext";
export { authClient, signIn, signOut, signUp, signUpWithPhone, useSession } from "./lib/auth-client";
export { encryptPassword } from "./lib/password-crypto";
export { AgentApiKeysPage } from "./pages/agent-panel/pages/AgentApiKeysPage";
export {
  AgentOrganizationsPage,
  type AgentOrganizationsPageProps,
} from "./pages/agent-panel/pages/AgentOrganizationsPage";
export type {
  MachineRegistryPort,
  MachineView,
} from "./pages/agent-panel/pages/agent-organizations-types";
