import { createLogger } from "@fenix/logger";
import { loadConfig } from "./config";
import { migrateDatabase } from "./db/migrate";
import { createClusterRuntime } from "./runtime";

const logger = createLogger("cluster");

const config = loadConfig();
migrateDatabase(config.databasePath);
const runtime = createClusterRuntime(config);
const api = runtime.apiApp.listen({ hostname: config.host, port: config.port });
const plugin = runtime.pluginApp.listen({ hostname: config.host, port: config.frpPluginPort });
runtime.monitor.start();
runtime.worker.start();

logger.info("OpenSandbox Cluster listening", { host: api.server?.hostname, port: api.server?.port });
logger.info("OpenSandbox FRP plugin listening", { host: plugin.server?.hostname, port: plugin.server?.port });

const shutdown = async () => {
  runtime.monitor.stop();
  api.stop();
  plugin.stop();
  await runtime.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
