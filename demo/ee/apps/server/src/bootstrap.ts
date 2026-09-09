import { loadServerEnv, serverHostEnv } from "@fenix-ce/platform-sdk/server-env";
import { assembleEeApplication, resolveEeModules } from "./app";
import { eeAssemblyConfig } from "./assembly-config";
import { createEnterpriseAppRoutes } from "./routes/app";

/** EE server 按部署配置选择已内置模块，同时复用 CE 启动约定。 */
export function bootstrapEeServer() {
  const installedModules = resolveEeModules(eeAssemblyConfig);
  const env = loadServerEnv([...serverHostEnv, ...installedModules.flatMap((module) => module.envDefinitions ?? [])]);
  const eeApp = assembleEeApplication(eeAssemblyConfig, { env }, installedModules);
  const routes = createEnterpriseAppRoutes({ agentConfigs: eeApp.agentConfigs, agentRuns: eeApp.agentRuns });
  return { env, routes };
}
