import { getAgentConfigModule } from "@fenix/agent-config/server";
import { bindAgentConfigLookupPort, bindAgentLaunchSpecPort } from "@fenix/agent-runtime/server";
import { ensureSystemAdmin } from "@fenix/identity/server";
import { createLogger } from "@fenix/logger";
import {
  createModelGatewayRuntime,
  createSystemModelGatewayProviderService,
  getModelManagementModule,
} from "@fenix/model-management/server";
import { getHermesClient, initHermesClient } from "@fenix/resource-channel/server";
import { checkRagFlowHealth } from "@fenix/resource-knowledge/server";
import {
  closeAllFileWsConnections,
  startFileWsSweep,
  startMachineSweep,
  stopFileWsSweep,
} from "@fenix/resource-machine/server";
import {
  initializeDefaultSandboxPool,
  registerConfiguredSandboxProviders,
  sandboxManager,
} from "@fenix/resource-sandbox/server";
import { schedulerService } from "@fenix/resource-task/server";
import { initCustomToolsRegistry } from "@fenix/resource-workflow/server";
import { bootstrapServerAssembly } from "../bootstrap";
import { config } from "../config";
import { initDb, client as pgClient } from "../db";
import { findDeprecatedEnvVars } from "../env";
import type { ServerEnv } from "../env-loader";
import { closeCache } from "../services/cache";
import { initCoreRuntime } from "../services/core-bootstrap";
import { runDataMigrations } from "../services/data-migrate";
import { createModelGatewaySubjectVerification } from "../services/model-gateway-subject-verification";
import { createPreLaunchPorts, type PreLaunchPortsDeps } from "../services/pre-launch-ports";
import { syncBuiltin } from "../services/sync-builtin";
import type { AgentRuntimeHandles } from "./host-wiring";
import { mountServerRouteContribution } from "./route-contributions";
import { startSchedulerUnlessDisabled } from "./scheduler-startup";
import { runCriticalStartupSequence } from "./startup-sequence";

/**
 * 宿主启动序与关闭序（`main.ts` 只负责入口：读 env、建 app、listen、挂信号）。
 *
 * 顺序约束集中在两个函数里，两侧都不可重排：
 *
 * **启动**（`startHostRuntime`）：DB → 模块装配 → 模型网关是 §3.1 钉下的关键序列（`initModelGateway` 里的
 * `ensureSystemAdmin` / `runDataMigrations` / 沙盒崩溃恢复是宿主进程级动作，不是任何模块的贡献），随后才是
 * 「启动前取数端口 → 沙盒默认池 → Core runtime → 调度器 → builtin 同步 → 自定义节点工具 → Hermes → RagFlow
 * 体检 → 巡检定时器 → 空闲监视」。其中「启动前取数端口」必须晚于 `wirePermissions`（agent-config / skill /
 * mcp / model-management 四个模块那时才装配完成），且晚于模型网关凭证解析器就绪。
 *
 * **关闭**（`shutdownHostRuntime`）：与启动严格反向冻结——先停接受新工作的（runtime drain / 调度器 /
 * Hermes），再停巡检定时器，最后关连接、缓存与 DB；每一步都有独立超时，超时只记日志不阻断后续步骤。
 *
 * 日志模块名沿用 `rcs`（与 `main.ts` 的入口日志同名）：启动/关闭是同一个进程生命周期，输出里区分「来自哪个
 * 文件」没有诊断价值。
 */
const startupLog = createLogger("rcs");

/** 关闭阶段的总预算；每个阶段另有自己的剩余时间片。 */
const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * 把 `promise` 限制在 `deadline` 之前完成；超时记日志并放行后续阶段。
 *
 * 关闭不是「必须全部成功」的流程：一个阶段卡住时，继续关掉其它资源比整体挂死更有价值（进程仍会退出）。
 */
function withShutdownDeadline<T>(promise: Promise<T>, phase: string, deadline: number): Promise<T | undefined> {
  const remaining = Math.max(0, deadline - Date.now());
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        startupLog.error(`Shutdown phase timed out: ${phase}`);
        resolve(undefined);
      }, remaining).unref?.();
    }),
  ]);
}

/** 按关键序列与启动后编排完成全部启动步骤；`agentRuntime` 来自 `wireHostRuntime()`。 */
export async function startHostRuntime(env: ServerEnv, agentRuntime: AgentRuntimeHandles): Promise<void> {
  // 模型网关的运行时凭证解析器：在启动序列里解析后交给 agent-config 的启动参数组装器
  // （见下方 `createPreLaunchPorts` + 端口绑定）。W4b 删掉 agent-runtime 的旧解析器槽位后，
  // 这是唯一注入点：组装器遇到 `kind = "gateway"` 的 Provider 时用它换签发凭证。
  let runtimeCredentialResolver: PreLaunchPortsDeps["runtimeCredentialResolver"];

  await runCriticalStartupSequence({
    initDb: async () => {
      await initDb();
      startupLog.info("Database initialized");
    },
    wirePermissions: async () => {
      // 模块装配改由 registry 驱动（1.5e 起逐个资源模块迁入，1.5f 全面切换）：按 `deploy/assembly/ce.json`
      // 的 profile 拓扑序 create 各模块，再把 `app-route` 贡献登记到宿主聚合槽（槽的消费点在 `main.ts` 的
      // app 构造处）。授权绑定不再手写——各资源模块在自己的 manifest 里声明 `accessControlBindings`，
      // access-control 的工厂经 `declarations` 汇总（review §3.2）。
      //
      // 时机不变：模型网关与 builtin 都会查询资源授权，装配必须在业务资源初始化前完成；本步骤仍在关键
      // 启动序列内、`initDb` 之后（`getDatabase()` 此时可用）。
      await bootstrapServerAssembly({ mountContribution: mountServerRouteContribution });
    },
    initModelGateway: async () => {
      registerConfiguredSandboxProviders();

      // 部署侧配置旧变量时显式提示，避免死配置被 zod strip 静默丢弃。
      for (const { name, replacement } of findDeprecatedEnvVars()) {
        startupLog.warn(
          `Deprecated environment variable ${name} is ignored; use ${replacement} instead (local execution only, remote engine is controlled by machine-side AGENT_TYPE)`,
        );
      }

      // 先应用 env，再跑系统初始化：system admin 需要读取密码文件路径配置。
      const systemAdmin = await ensureSystemAdmin();
      startupLog.info(`System admin ready: ${systemAdmin.email}`);

      // 数据迁移仍要早于 builtin 同步，避免旧数据结构影响系统资源落盘位置。
      await runDataMigrations();
      startupLog.info("Data migrations completed");

      // 上游凭据的主体复验端口：用已装配的授权能力 + agent_config 的资源定义，与平台其它入口判定
      // Agent 可用性的是同一条规则（见 `services/model-gateway-subject-verification`）。
      const modelManagement = getModelManagementModule();
      const subjectVerification = createModelGatewaySubjectVerification({
        accessControl: modelManagement.accessControl,
        identity: modelManagement.identity,
        findAgentConfigOrganization: async (agentConfigId) =>
          (await getAgentConfigModule().service.findRowUnscoped(agentConfigId))?.organizationId,
      });

      const modelGatewayRuntime = createModelGatewayRuntime({ subjectVerification });
      if (modelGatewayRuntime) {
        await modelGatewayRuntime.services.provider.ensureProvider();
        runtimeCredentialResolver = modelGatewayRuntime.resolveRuntimeCredential;
        startupLog.info("Model gateway runtime initialized");
        return;
      }

      // Provider 投影即使未配置管理凭证也需要存在，便于管理端显示待配置状态。
      await createSystemModelGatewayProviderService(
        {},
        {
          baseUrl: config.modelGatewayPublicBaseUrl,
          gatewayType: config.modelGatewayType,
        },
      ).ensureProvider();
    },
  });

  // agent-runtime 的「启动前取数」两个端口（启动参数组装 + Agent 配置查询）：实现在 agent-config，宿主
  // 装配后绑定（见 `services/pre-launch-ports.ts`）。绑定点必须在 `wirePermissions` 之后——那时 agent-config /
  // skill / mcp / model-management 四个模块才装配完成；也必须在这里才能拿到模型网关凭证解析器。
  const preLaunchPorts = createPreLaunchPorts({
    runtimeCredentialResolver,
    hindsightApiToken: env.HINDSIGHT_API_TOKEN,
  });
  bindAgentLaunchSpecPort(preLaunchPorts.launchSpec);
  bindAgentConfigLookupPort(preLaunchPorts.lookup);
  startupLog.info("Pre-launch ports bound (agent launch spec / agent config lookup)");

  // 沙盒默认池初始化与崩溃恢复（Sandbox 能力，早于 core runtime 启动）。
  // 失败不阻断启动：沙盒不可用时仅影响沙盒执行节点，普通执行路径不受影响。
  try {
    // 配置由包自己经 `getModuleConfig("sandbox")` 读取，宿主不再把整个 config 传进模块。
    const defaultPool = await initializeDefaultSandboxPool();
    if (defaultPool) startupLog.info(`Default sandbox pool initialized: ${defaultPool.id}`);
  } catch (error) {
    startupLog.error("Failed to initialize default sandbox pool", error instanceof Error ? error : undefined);
  }

  await sandboxManager.recoverAfterRestart();

  await initCoreRuntime();
  startupLog.info("Core runtime initialized");

  await startSchedulerUnlessDisabled({
    disabled: env.RCS_DISABLE_SCHEDULER,
    start: () => schedulerService.start(),
    onDisabled: () => startupLog.info("Scheduler startup disabled by RCS_DISABLE_SCHEDULER"),
  });

  try {
    // builtin 资源现在统一托管到系统 admin 组织，不再在启动时遍历所有组织复制副本。
    await syncBuiltin();
    startupLog.info("Builtin resources synced");
  } catch (err) {
    startupLog.error("Failed to sync builtin resources", err instanceof Error ? err : undefined);
  }

  // 初始化自定义节点工具注册表：扫描 WORKFLOW_TOOLS_DIR，注册 SlurmNode 子类。
  // 必须在 getTeamEngine() 调用前完成，否则 yaml 中 type: custom 的节点会因 tool 未注册而失败。
  // discover 内部已捕获异常并 fallback 到空 registry，不会阻塞服务启动。
  await initCustomToolsRegistry();
  startupLog.info("Custom tools registry initialized");

  // Initialize Hermes client if configured
  // biome-ignore lint/suspicious/noExplicitAny: config channels shape is dynamic
  const hermesUrl = process.env.HERMES_URL ?? (config as any).channels?.hermesUrl;
  if (hermesUrl) {
    // 平台清单是**部署配置值**（不是环境变量名）：包侧不读 process.env，由宿主在这里下发。
    initHermesClient(hermesUrl, { platforms: env.HERMES_PLATFORMS });
  }

  // Verify RagFlow connectivity (non-blocking — logs warning on failure)
  const ragflowHealth = await checkRagFlowHealth();
  if (ragflowHealth.ok) {
    console.log(`[startup] ${ragflowHealth.message}`);
  } else {
    console.warn(`[startup] RagFlow health check failed: ${ragflowHealth.message}`);
  }

  // 定期巡检：将无活跃 WS 连接的 machine 标为 offline（处理服务重启、网络分区等场景）
  startMachineSweep(60_000);
  // file-ws 僵尸连接巡检（P0-1）：独立于 startMachineSweep——后者只查 DB 中 status=online
  // 的机器（registry-heartbeat.ts），覆盖不到 file-ws 的 half-open 僵尸。默认关闭，
  // 灰度防误杀旧机器端（keep_alive 缺失或间隔 >90s），开启时按配置间隔巡检。
  if (config.fileWsSweepEnabled) {
    startFileWsSweep(config.fileWsSweepIntervalMs, config.fileWsIdleTimeoutMs);
  }
  agentRuntime.startIdleMonitor();
}

/** 逆序关闭全部宿主运行态；调用方负责进程退出。 */
export async function shutdownHostRuntime(agentRuntime: AgentRuntimeHandles): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
  const runtimeDrain = agentRuntime.shutdown();
  schedulerService.stop();
  const hermesClient = getHermesClient();
  await withShutdownDeadline(hermesClient?.stop() ?? Promise.resolve(), "hermes", deadline);
  agentRuntime.stopIdleMonitor();
  agentRuntime.closeAllRelayConnections();
  agentRuntime.closeAllAcpConnections();
  // 先停巡检再关连接，避免巡检定时器与关闭流程并发操作同一索引
  stopFileWsSweep();
  closeAllFileWsConnections();
  await withShutdownDeadline(runtimeDrain, "runtimes", deadline);
  await withShutdownDeadline(closeCache(), "cache", deadline);
  await withShutdownDeadline(pgClient.end(), "database", deadline);
}
