import { loadServerEnv, serverHostEnv } from "@fenix-ce/platform-sdk/server-env";
import { assembleCeApplication, resolveCeModules } from "./app";
import { ceAssemblyConfig } from "./assembly-config";
import { createAppRoutes } from "./routes/app";

/** server 的唯一装配入口：统一加载 env 并汇总 /app routes。 */
export function bootstrapCeServer() {
  const installedModules = resolveCeModules(ceAssemblyConfig);
  const env = loadServerEnv([...serverHostEnv, ...installedModules.flatMap((module) => module.envDefinitions ?? [])]);
  const ceApp = assembleCeApplication(ceAssemblyConfig, { env }, installedModules);
  const routes = createAppRoutes({ agentConfigs: ceApp.agentConfigs, agentRuns: ceApp.agentRuns });
  return { env, routes };
}
