import { demoLogger } from "@fenix-ce/observability";
import { loadServerEnv, postgresEnv } from "../../../../ce/apps/server/src/env";
import { assembleEeApplication } from "./app";
import { eeAssemblyConfig } from "./assembly-config";
import { enterpriseAccessControlEnv } from "./env";
import { createEnterpriseAppRoutes } from "./routes/app";

/** EE server 按部署配置选择已内置模块，同时复用 CE 启动约定。 */
export function bootstrapEeServer() {
  const eeApp = assembleEeApplication(eeAssemblyConfig);
  const env = loadServerEnv([...postgresEnv, ...enterpriseAccessControlEnv]);
  const routes = createEnterpriseAppRoutes({ agentConfigs: eeApp.agentConfigs, agentRuns: eeApp.agentRuns });
  demoLogger.info("server.bootstrapped", { edition: "ee", routeCount: routes.length });
  return { env, routes };
}
