import { loadConfig } from "./config";
import { migrateDatabase } from "./db/migrate";
import { createClusterRuntime } from "./runtime";

const config = loadConfig();
migrateDatabase(config.databasePath);
const runtime = createClusterRuntime(config);
const api = runtime.apiApp.listen({ hostname: config.host, port: config.port });
const plugin = runtime.pluginApp.listen({ hostname: config.host, port: config.frpPluginPort });
runtime.monitor.start();

console.log(`OpenSandbox Cluster listening on http://${api.server?.hostname}:${api.server?.port}`);
console.log(`OpenSandbox FRP plugin listening on http://${plugin.server?.hostname}:${plugin.server?.port}`);

const shutdown = () => {
  runtime.monitor.stop();
  api.stop();
  plugin.stop();
  runtime.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
