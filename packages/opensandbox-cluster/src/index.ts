import { createApp } from "./app";
import { loadConfig } from "./config";
import { migrateDatabase } from "./db/migrate";

const config = loadConfig();
migrateDatabase(config.databasePath);
const app = createApp(config).listen({ hostname: config.host, port: config.port });

console.log(`OpenSandbox Cluster listening on http://${app.server?.hostname}:${app.server?.port}`);
