import { createWebConfigAgentsRoutes } from "@fenix/agent-config/server";
import { createWebConfigModelsRoutes, createWebConfigProvidersRoutes } from "@fenix/model-management/server";
import { createWebMcpConfigRoutes } from "@fenix/resource-mcp/server";
import { createWebSandboxPoolsRoutes } from "@fenix/resource-sandbox/server";
import { createWebSkillsConfigRoutes } from "@fenix/resource-skill/server";
import Elysia, { type AnyElysia } from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import {
  resolveSecretReference,
  userAgentPreferences,
  userModelPreferences,
} from "../../../services/resource-module-ports";

// 资源包路由一律改为工厂：守卫必须与宿主的认证解析是同一份实例、偏好端口必须落在身份族的
// `user_config` 表上（Elysia 的 macro / state 是实例作用域的，父实例无法向已构造的子实例回填），
// 因此在这里注入而不是让包自建。端口实现见 `services/resource-module-ports.ts`。
const providers = createWebConfigProvidersRoutes({ authGuardPlugin, resolveSecretReference });
const sandboxPools = createWebSandboxPoolsRoutes({ authGuardPlugin });
const models = createWebConfigModelsRoutes({ authGuardPlugin, userModelPreferences });
const agents = createWebConfigAgentsRoutes({ authGuardPlugin, userAgentPreferences });
const skills = createWebSkillsConfigRoutes({ authGuardPlugin });
const mcp = createWebMcpConfigRoutes({ authGuardPlugin });

/**
 * `/web/config/*` 聚合实例。
 *
 * `contributedRoutes` 是按 registry 装配结果登记到 `web-config` 槽的路由（1.5e 起逐包从上面的手写序列
 * 迁入）。挂载位置在宿主手写序列之后：贡献之间的相对顺序由装配收集顺序决定，兜底类贡献在自己声明处写
 * `order` 自证优先级（review §3.3），宿主不再维护「谁必须最后挂」的清单。
 *
 * 改为工厂（不再是模块级单例）的原因：贡献实例只有在 `bootstrapServerAssembly()` 的 mount 阶段才存在，
 * 而装配跑在 app 构造之前——顶层构造的单例拿不到它们（review §3.3 的时序）。
 */
export function createWebConfigApp(contributedRoutes: readonly AnyElysia[]): AnyElysia {
  return (
    new Elysia({ name: "web-config" })
      .use(providers)
      .use(sandboxPools)
      .use(models)
      .use(agents)
      .use(skills)
      .use(mcp)
      // Elysia 的 `.use()` 接数组参数（不是展开），见 `node_modules/elysia/dist/index.d.ts` 的重载。
      .use([...contributedRoutes])
  );
}
