import { demoLogger } from "@fenix-ce/observability";
import { assembleCeApplication } from "./app";
import { ceAssemblyConfig } from "./assembly-config";
import { loadServerEnv, postgresEnv } from "./env";
import { createAppRoutes } from "./routes/app";

/** server 的唯一装配入口：统一加载 env、注入观测实现并汇总 /app routes。 */
export function bootstrapCeServer() {
  const ceApp = assembleCeApplication(ceAssemblyConfig);
  const env = loadServerEnv(postgresEnv);
  const routes = createAppRoutes({ agentConfigs: ceApp.agentConfigs, agentRuns: ceApp.agentRuns });
  demoLogger.info("server.bootstrapped", { edition: "ce", routeCount: routes.length });
  return { env, routes };
}
