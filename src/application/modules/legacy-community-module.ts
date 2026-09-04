import type { ModuleStartContext } from "@fenix/server-runtime";
import Elysia, { type Elysia as ElysiaType } from "elysia";
import { initDb, client as pgClient } from "../../db";
import { findDeprecatedEnvVars } from "../../env";
import acpRoutes from "../../routes/acp";
import { agentSitesCompatApp, agentSitesProxyApp } from "../../routes/agent-sites-proxy";
import apiAgentsRoutes from "../../routes/api/agents";
import apiInstanceRoutes from "../../routes/api/instances";
import apiKnowledgeBaseRoutes from "../../routes/api/knowledge-bases";
import apiMcpRoutes from "../../routes/api/mcp";
import apiModelsRoutes from "../../routes/api/models";
import openaiChatRoutes from "../../routes/api/openai-chat";
import apiSandboxRoutes from "../../routes/api/sandbox";
import apiSandboxClusterRoutes from "../../routes/api/sandbox-cluster";
import apiSandboxServerRoutes from "../../routes/api/sandbox-server";
import apiSkillsRoutes from "../../routes/api/skills";
import apiSystemRoutes from "../../routes/api/system";
import apiSystemLogsRoutes from "../../routes/api/system-logs";
import apiSystemModelGatewayRoutes from "../../routes/api/system-model-gateway";
import apiSystemObserverRoutes from "../../routes/api/system-observer";
import apiSystemPeopleTreeRoutes from "../../routes/api/system-people-tree";
import apiWorkflowRoutes from "../../routes/api/workflows";
import apiWorkspaceRoutes from "../../routes/api/workspaces";
import knowledgeMcpRoutes from "../../routes/mcp/knowledge";
import skillDownloadRoutes from "../../routes/skills";
import webApp from "../../routes/web";
import { workflowStaticApp } from "../../routes/web/workflow-proxy";
import { startAcpIdleMonitor, stopAcpIdleMonitor } from "../../services/acp-idle-monitor";
import { closeCache } from "../../services/cache";
import { initCoreRuntime } from "../../services/core-bootstrap";
import { runDataMigrations } from "../../services/data-migrate";
import { type HermesClient, initHermesClient } from "../../services/hermes-client";
import { stopAllInstances } from "../../services/instance";
import { checkRagFlowHealth } from "../../services/knowledge-provider/ragflow";
import { setRuntimeCredentialResolver } from "../../services/launch-spec-builder";
import { createSystemModelGatewayProviderService } from "../../services/model-gateway/provider-service";
import { createModelGatewayRuntime } from "../../services/model-gateway/runtime";
import { startMachineSweep, stopMachineSweep } from "../../services/registry-heartbeat";
import { registerConfiguredSandboxProviders, sandboxManager } from "../../services/sandbox";
import { initializeDefaultSandboxPool } from "../../services/sandbox/sandbox-default-pool";
import { schedulerService } from "../../services/scheduler";
import { syncBuiltin } from "../../services/sync-builtin";
import { ensureSystemAdmin } from "../../services/system-admin";
import { initCustomToolsRegistry } from "../../services/workflow/custom-tools";
import { closeAllAcpConnections } from "../../transport/acp-ws-handler";
import { closeAllFileWsConnections, startFileWsSweep, stopFileWsSweep } from "../../transport/file-ws-handler";
import { closeAllRelayConnections } from "../../transport/relay";
import type { DefaultApplicationOptions } from "../default-app-options";

const LEGACY_COMMUNITY_ROUTE_APPS = [
  webApp,
  skillDownloadRoutes,
  agentSitesProxyApp,
  apiAgentsRoutes,
  apiKnowledgeBaseRoutes,
  apiSkillsRoutes,
  apiModelsRoutes,
  apiMcpRoutes,
  apiSystemRoutes,
  apiSystemLogsRoutes,
  apiSystemModelGatewayRoutes,
  apiSystemObserverRoutes,
  apiSystemPeopleTreeRoutes,
  apiSandboxRoutes,
  apiSandboxClusterRoutes,
  apiSandboxServerRoutes,
  apiInstanceRoutes,
  apiWorkspaceRoutes,
  apiWorkflowRoutes,
  openaiChatRoutes,
  workflowStaticApp,
  knowledgeMcpRoutes,
  acpRoutes,
  agentSitesCompatApp,
] as const;

type UnionToIntersection<TValue> = (TValue extends unknown ? (value: TValue) => void : never) extends (
  value: infer TIntersection,
) => void
  ? TIntersection
  : never;

type LegacyCommunityRouteTree = UnionToIntersection<(typeof LEGACY_COMMUNITY_ROUTE_APPS)[number]["~Routes"]>;

type LegacyCommunityRoutes = ElysiaType<
  ElysiaType["~Prefix"],
  ElysiaType["~Singleton"],
  ElysiaType["~Definitions"],
  ElysiaType["~Metadata"],
  LegacyCommunityRouteTree,
  ElysiaType["~Ephemeral"],
  ElysiaType["~Volatile"]
>;

/** 创建承接现有社区应用边界的过渡性服务模块。 */
export function createLegacyCommunityModule(options: DefaultApplicationOptions) {
  return {
    name: "legacy-community",
    createRoutes: createLegacyCommunityRoutes,
    async start({ signal }: ModuleStartContext) {
      await initDb();
      options.logger.info("Database initialized");
      throwIfAborted(signal);
      registerConfiguredSandboxProviders();

      for (const { name, replacement } of findDeprecatedEnvVars()) {
        options.logger.warn(
          `Deprecated environment variable ${name} is ignored; use ${replacement} instead (local execution only, remote engine is controlled by machine-side AGENT_TYPE)`,
        );
      }

      const systemAdmin = await ensureSystemAdmin();
      options.logger.info(`System admin ready: ${systemAdmin.email}`);
      throwIfAborted(signal);

      await runDataMigrations();
      options.logger.info("Data migrations completed");
      throwIfAborted(signal);

      const modelGatewayRuntime = createModelGatewayRuntime();
      if (modelGatewayRuntime) {
        await modelGatewayRuntime.services.provider.ensureProvider();
        setRuntimeCredentialResolver(modelGatewayRuntime.resolveRuntimeCredential);
        options.logger.info("Model gateway runtime initialized");
      } else {
        await createSystemModelGatewayProviderService(
          {},
          {
            baseUrl: options.config.modelGatewayPublicBaseUrl,
            gatewayType: options.config.modelGatewayType,
          },
        ).ensureProvider();
      }
      throwIfAborted(signal);

      try {
        const defaultPool = await initializeDefaultSandboxPool(options.config);
        if (defaultPool) options.logger.info(`Default sandbox pool initialized: ${defaultPool.id}`);
      } catch (error) {
        options.logger.error("Failed to initialize default sandbox pool", error instanceof Error ? error : undefined);
      }
      throwIfAborted(signal);

      await sandboxManager.recoverAfterRestart();
      throwIfAborted(signal);

      await initCoreRuntime();
      options.logger.info("Core runtime initialized");
      throwIfAborted(signal);

      await schedulerService.start();
      throwIfAborted(signal);

      try {
        await syncBuiltin();
        options.logger.info("Builtin resources synced");
      } catch (error) {
        options.logger.error("Failed to sync builtin resources", error instanceof Error ? error : undefined);
      }
      throwIfAborted(signal);

      await initCustomToolsRegistry();
      options.logger.info("Custom tools registry initialized");
      throwIfAborted(signal);

      const hermesClient = options.env.HERMES_URL ? initHermesClient(options.env.HERMES_URL) : undefined;

      const ragflowHealth = await checkRagFlowHealth();
      if (ragflowHealth.ok) {
        options.logger.info(ragflowHealth.message);
      } else {
        options.logger.warn(`RagFlow health check failed: ${ragflowHealth.message}`);
      }
      throwIfAborted(signal);

      startMachineSweep(60_000);
      if (options.config.fileWsSweepEnabled) {
        startFileWsSweep(options.config.fileWsSweepIntervalMs, options.config.fileWsIdleTimeoutMs);
      }
      startAcpIdleMonitor();

      return () => disposeLegacyCommunity(hermesClient);
    },
  };
}

function createLegacyCommunityRoutes(): LegacyCommunityRoutes {
  const app = new Elysia({ name: "legacy-community" });
  for (const routes of LEGACY_COMMUNITY_ROUTE_APPS) app.use(routes);

  // 类型由同一有序 route tuple 推导，避免 Elysia 对完整社区路由树再次递归展开。
  return app as unknown as LegacyCommunityRoutes;
}

async function disposeLegacyCommunity(hermesClient: HermesClient | undefined): Promise<void> {
  const operations: Array<{ name: string; run: () => void | Promise<void> }> = [
    { name: "hermes", run: () => hermesClient?.stop() },
    { name: "acp-idle-monitor", run: stopAcpIdleMonitor },
    { name: "machine-sweep", run: stopMachineSweep },
    { name: "file-ws-sweep", run: stopFileWsSweep },
    { name: "scheduler", run: () => schedulerService.stop() },
    { name: "relay-connections", run: closeAllRelayConnections },
    { name: "acp-connections", run: closeAllAcpConnections },
    { name: "file-ws-connections", run: closeAllFileWsConnections },
    { name: "agent-instances", run: stopAllInstances },
    { name: "cache", run: closeCache },
    { name: "postgres", run: () => pgClient.end() },
  ];
  const errors: Error[] = [];
  for (const operation of operations) {
    try {
      await operation.run();
    } catch (error) {
      errors.push(new Error(`Failed to dispose ${operation.name}`, { cause: error }));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Legacy community module disposal failed");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("Legacy community module startup aborted");
}
