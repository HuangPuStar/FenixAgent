/**
 * Agent Runtime 服务端测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 与 machine / knowledge / sandbox 的同名入口同口径，收敛四件事，避免宿主 preload 与包内用例各抄一份字段清单：
 * 1. 「字段齐全 + 缺省值」的模块配置构造（宿主 preload 的基线登记与本包用例共用这一份真相）；
 * 2. 经 `initializeTestApplicationInfrastructure()` 走**生产读取路径**（`getAgentRuntimeConfig()` →
 *    `getModuleConfig("agent-runtime")`）完成装配，而不是给包内代码留测试专用配置分支；
 * 3. 用例内调整配置的 `overrideModuleConfig()` 入口（基础设施只允许初始化一次）；
 * 4. 运行 port 的替身装配（`stubAgentRuntimePort` / `resetAgentRuntimePort`）——1.4 W3b 起消费方经
 *    `getBoundAgentRuntime()` 取运行能力，替换点因此收敛到绑定本身。
 *
 * 为什么包内用例不能改用 `getModuleConfigStub()`：那是宿主 preload 为「刻意不初始化基础设施」的进程准备的
 * 模块级替身（见 platform-sdk 的 `module-config-stub.ts`）；本包生产代码读的是 `getModuleConfig()`，
 * 配置必须真的经 `initializeApplicationInfrastructure()` 装进去。
 */

import { join } from "node:path";
import type { CoreRuntimeFacade } from "@fenix/core";
import { overrideModuleConfig } from "@fenix/platform-sdk/server";
import {
  getDbStub,
  initializeTestApplicationInfrastructure,
  registerStubResetter,
  resetAllStubs,
} from "@fenix/platform-sdk/testing";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { AgentRuntime } from "../runtime";
import { bindAgentRuntime, createAgentRuntime, resetAgentRuntimeForTest } from "../runtime";
import type { AgentRuntimeModuleConfig } from "./config";
import { getAgentRuntimeConfig } from "./config";
import { resetEnvironmentRepoStubForTest, setEnvironmentRepoStub } from "./repositories/environment";
import {
  type AgentLaunchSpecPort,
  bindAgentLaunchSpecPort,
  resetAgentLaunchSpecPort,
} from "./services/agent-launch-spec-port";
import {
  bindCoreRuntimePort,
  type CoreRuntimePort,
  getBoundCoreRuntimePort,
  resetCoreRuntimePortForTest,
} from "./services/core-runtime-port";
import {
  bindMachineRegistryPort,
  getMachineRegistryPort,
  type MachineRegistryPort,
  resetMachineRegistryPortForTest,
} from "./services/machine-registry-port";

// ─────────────────────────────────────────────────────────────────────────────
// 包内处理函数与内部登记表的测试 seam（1.4 W6b）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 驱动包内处理函数、读写内部登记表的 seam。
 *
 * 这些名字**只对测试有意义**：生产消费方要么已经经运行 port（`@fenix/agent-runtime/runtime`）
 * 取能力，要么属于宿主装配面。放在这里而不是留在生产 `./server` 上，是因为跨包用例无法改相对导入
 * ——`./server` 上留着它们等于把「测试可以驱动内部实现」变成公开契约的一部分。
 *
 * 三类用途：
 * 1. **驱动协议处理函数**：`handleAcpWsOpen` / `handleAcpWsClose` / `handleExternalRelayOpen` /
 *    `handleExternalRelayClose` 建连接、`setExternalRelayDeps` 装其协作者、`listAcpConnections` /
 *    `listExternalRelayEntries` 读回登记表快照——observer 的集成用例借此验证快照字段与句柄不外泄；
 * 2. **读写实例登记表与活跃度**：`globalInstanceRegistry`（workflow 用例断言 relayCount / activity）、
 *    `shouldCountInstanceActivity`（保活消息过滤）；
 * 3. **复位编排替身与总线**：`setOrchestrationInstanceDeps` / `resetOrchestrationInstanceDeps` /
 *    `resetOrchestrationBootstrap` / `createExecutionNodeResolver`、`createPromptTurn`
 *    （真实 turn 的过滤层可达性回归）、`KEBAB_CASE_RE` / `validateWorkspacePath`、`EventBus`（值）。
 *
 * `getAllEventBuses` / `removeEventBus` 同时被宿主装配层使用（`bindSessionEventBusPort` 的实现来源），
 * 它们在生产 `./server` 上另有出口；这里再出口一次是为了让 workflow 的 SSE 用例不必从生产面取数。
 */
export { shouldCountInstanceActivity } from "../services/acp-idle-monitor";
export { createPromptTurn } from "../services/agent-chat-service";
export { KEBAB_CASE_RE, validateWorkspacePath } from "../services/environment-core";
export { globalInstanceRegistry } from "../services/instance-registry";
export { createExecutionNodeResolver, resetOrchestrationBootstrap } from "../services/orchestration-bootstrap";
export { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";
export { EventBus, getAllEventBuses, removeEventBus } from "../transport/event-bus";
export { getBoundCoreRuntimePort, resetCoreRuntimePortForTest } from "./services/core-runtime-port";
export { handleAcpWsClose, handleAcpWsOpen, listAcpConnections } from "./transport/acp-ws-handler";
export {
  handleExternalRelayClose,
  handleExternalRelayOpen,
  listExternalRelayEntries,
  setExternalRelayDeps,
} from "./transport/relay/external-relay";

/**
 * 构造一份字段齐全的 Agent Runtime 模块配置。
 *
 * 超时/保活旋钮取宿主部署默认值（`apps/server/src/env.ts` 的 zod default，与 `apps/server/src/config.ts`
 * 同源）：ACP 空闲 / 巡检 / 业务超时 300 / 300 / 1200 秒，WS 保活间隔 20 秒。
 *
 * **三个并发上限刻意不设置**。它们在宿主 env schema 里是 `optional`（`RCS_USER_AGENT_MAX_CONCURRENCY` 除外，
 * 部署默认 10），而迁移前宿主测试进程读到的是 `buildConfig({} as Env)`——即全部 `undefined`，限流不生效。
 * 这里若照抄部署默认值，`userAgentMaxConcurrency: 10` 会给宿主用例新引入一条它们从未见过的用户级配额
 * （单用户多实例的用例会变成 429）。需要验证限流的用例显式传值。
 *
 * 其余部署值同理按「宿主测试进程实际读到的值」填：`workspaceRoot` 取宿主 `config.ts` 对空 env 的解析结果
 * （`WORKSPACE_ROOT ?? ./workspaces` 相对 cwd 的绝对路径）；`disableLocalExecution` 取 `false`（宿主 env
 * 默认值）。兜底机器 ID 不在本配置里，它归 machine 模块（`getMachineConfig().defaultMachineId`），需要它的
 * 用例经 `stubMachineModuleConfig` 之类入口调整 machine 那份配置。
 *
 * `defaultEngineType` 与 `baseUrl` 是 1.5b 新增的两个键（本地执行引擎类型 / 平台对外基址），原经宿主
 * `@server/config` 直读。`defaultEngineType` 刻意**不设**——迁移前宿主测试进程读到的是 `buildConfig({} as Env)`
 * 的 `undefined`，调用方回退 `"opencode"`；这里设值会让「缺省回退」这条分支失去覆盖。`baseUrl` 是必填项，
 * 取一个不可达的占位值（与 `buildInertLaunchSpec` 同口径），使用例无法静默依赖真实网络。
 *
 * `acpRegistrySecret` 刻意**不**照抄宿主 env 的 zod 默认值，而用一个显式的测试值：默认值是部署期密钥，
 * 写进 fixture 会让「密钥不得进入源码」的红线在测试代码里破口，也会让用例静默依赖那个字面量。需要与
 * `/acp/*` 端点握手的用例应从 `getAgentRuntimeConfig().acpRegistrySecret` 取值。
 */
export function createAgentRuntimeModuleConfig(
  overrides: Partial<AgentRuntimeModuleConfig> = {},
): AgentRuntimeModuleConfig {
  return {
    acpIdleTimeoutSeconds: 300,
    acpIdleSweepIntervalSeconds: 300,
    acpActivityTimeoutSeconds: 1200,
    wsKeepaliveInterval: 20,
    disableLocalExecution: false,
    workspaceRoot: join(process.cwd(), "workspaces"),
    baseUrl: "http://stub.invalid",
    acpRegistrySecret: "test-acp-registry-secret",
    fileWsMaxPayloadMb: 32,
    ...overrides,
  };
}

/**
 * DB 句柄替身的转发代理。
 *
 * `initializeApplicationInfrastructure()` 持有的是初始化那一刻的对象**引用**，而用例在 `beforeEach`
 * 里才登记本用例的 DB 替身（`stubDb()`）。若直接把当次替身传进去，后续每次 `stubDb()` 都不生效，
 * 症状是「第二个用例起读到上一个用例的 db」。因此这里传代理，按每次属性访问转发到当前替身
 * （与宿主 preload 的 `createDbMock` 同形，两处指向同一个 `getDbStub()`）。
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle 句柄形状随用例变化，读取方（仓储）自行收窄
const agentRuntimeDbProxy = new Proxy({} as Record<string, any>, {
  get: (_target, prop) => getDbStub()[prop as string],
});

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须在 `beforeEach` 调用：初始化只允许一次，而 `resetAllStubs()` 会连同应用基础设施一起复位，
 * 因此每个用例都能重新装配自己的配置与 DB 句柄。
 */
export function initializeAgentRuntimeModuleConfig(overrides: Partial<AgentRuntimeModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: agentRuntimeDbProxy,
    moduleConfigs: { "agent-runtime": createAgentRuntimeModuleConfig(overrides) },
  });
}

/**
 * 用例内改动模块配置。
 *
 * 基础设施持有的是初始化那一刻的整份配置，因此运行期调整走 `overrideModuleConfig()`——它是**整值替换**，
 * 这里按合并语义补齐其余字段：用例只想改一个并发上限，不该顺带把已设好的超时清空。读取经
 * `getAgentRuntimeConfig()`，与生产路径同一次校验。显式传 `undefined` 可回到「该上限不生效」。
 */
export function stubAgentRuntimeConfig(overrides: Partial<AgentRuntimeModuleConfig>): void {
  overrideModuleConfig("agent-runtime", { ...getAgentRuntimeConfig(), ...overrides });
}

/** 读取当前生效的模块配置（走生产校验路径，便于用例断言注入值确实被消费方看到）。 */
export { getAgentRuntimeConfig };

// ─────────────────────────────────────────────────────────────────────────────
// 宿主注入面的包内替身（§1.7 收尾）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这三组替身原先是宿主测试基建（`apps/server/src/test-utils/stubs/module-stubs.ts`）的出口，包内用例只能
 * 经 `@server/test-utils/stubs/module-stubs` 登记 —— 那批导入是 `apps-boundary` 台账最后一条
 * （`@fenix/agent-runtime → @fenix/server-app`，删除条件「测试侧归零」）的全部残留面。
 *
 * 三个接缝的实现归属本来就是本包（环境仓储、Core runtime 端口、Machine 注册端口都由本包声明），替身因此
 * 一并收回：宿主 preload 只保留「绑定生产实现」的职责，不再替本包登记替身。宿主用例需要时从本入口取
 * （宿主 preload 已经这么做，例如 `createAgentRuntimeModuleConfig`）。
 *
 * 三者的复位都挂到 `resetAllStubs()`（`registerStubResetter`）：用例在 `beforeEach` 调用的
 * `initializeAgentRuntimeModuleConfig()` 内含 `resetAllStubs()`，因此「单跑绿、全量跑红」这类跨用例泄漏
 * 不会因为漏复位而出现。
 */

/**
 * 环境仓储的部分替身：只替换传入的方法，未登记的方法走真实实现（语义见仓储模块的替身层注释）。
 *
 * 形状刻意与旧出口一致（`Record<string, unknown>` 浅合并），用例无需改动调用点：原来写
 * `stubEnvironmentRepo({ getById: async () => null })` 的地方现在只是换了 import 来源。
 */
export function stubEnvironmentRepo(overrides: Record<string, unknown>): void {
  setEnvironmentRepoStub(overrides);
}

/** 清空环境仓储替身层（也随 `resetAllStubs()` 自动执行）。 */
export const resetEnvironmentRepoStub = resetEnvironmentRepoStubForTest;

/** 上一次绑定的 Core runtime 端口（宿主 preload 期或上一个用例留下的），复位时绑回。 */
let savedCoreRuntimePort: CoreRuntimePort | null = null;

/**
 * 注入假 Core runtime facade（原宿主 `stubCoreBootstrap({ getCoreRuntime })`）。
 *
 * 只替换 `getCoreRuntime`：远端节点注册 / 注销继续走复位前绑定的端口（宿主 preload 把它们转发到宿主注册表，
 * 与迁移前 `stubCoreBootstrap` 只覆盖 `getCoreRuntime` 语义一致）。宿主端口未绑定时退化为空操作——包内单跑
 * （preload 未生效）时 `registerRemoteNode` 不应成为失败点，本包用例也不断言这两个动词。
 *
 * `null` 表示「对账面没有 facade」：`getCoreRuntime()` 返回 `null`（`acp-machine-connection-lookup` 用它
 * 覆盖「无 core 实例」分支）。
 *
 * 参数取 `unknown` 而不是 `CoreRuntimeFacade`：用例注入的是只覆盖被断言方法的部分 facade（如
 * `{ listInstances: () => [] }`），强类型会逼出成片的 `as never`，而收窄本就发生在被测代码里。真实实现的
 * 形状仍由端口与 `@fenix/core` 的 `CoreRuntimeFacade` 约束，替身只影响测试进程。
 */
export function stubCoreRuntimeFacade(facade: unknown): void {
  if (!coreRuntimeFacadeStubbed) {
    savedCoreRuntimePort = tryGetBoundCoreRuntimePort();
    coreRuntimeFacadeStubbed = true;
  }
  resetCoreRuntimePortForTest();
  bindCoreRuntimePort({
    getCoreRuntime: () => facade as CoreRuntimeFacade,
    registerRemoteNode: savedCoreRuntimePort?.registerRemoteNode ?? (() => {}),
    unregisterRemoteNode: savedCoreRuntimePort?.unregisterRemoteNode ?? (() => {}),
  });
}

/** 还原前一次绑定的 Core runtime 端口（并回到「未替身」状态）。 */
export function resetCoreRuntimeFacadeStub(): void {
  if (!coreRuntimeFacadeStubbed) return;
  resetCoreRuntimePortForTest();
  if (savedCoreRuntimePort) bindCoreRuntimePort(savedCoreRuntimePort);
  savedCoreRuntimePort = null;
  coreRuntimeFacadeStubbed = false;
}

let coreRuntimeFacadeStubbed = false;

/** 读取已绑定端口；未绑定时返回 `null`（供替身保存/还原，不做 fail-fast）。 */
function tryGetBoundCoreRuntimePort(): CoreRuntimePort | null {
  try {
    return getBoundCoreRuntimePort();
  } catch {
    return null;
  }
}

/** 上一次绑定的 Machine 注册端口（同上）。 */
let savedMachineRegistryPort: MachineRegistryPort | null = null;
let machineRegistryPortStubbed = false;

/** 未登记且无前次绑定时的默认实现：显式抛错而不是返回 `undefined`，让漏登记立刻可定位。 */
function unconfiguredMachineRegistryMethod(name: string): never {
  throw new Error(`MachineRegistryPort stub '${name}' not configured, call stubMachineRegistryPort() in beforeEach`);
}

/**
 * Machine 注册端口的部分替身（原宿主 `stubRegistry` / `stubRegistryHeartbeat`）。
 *
 * 未登记的方法按「前次绑定 → 默认」取值：前次绑定即宿主 preload 的转发端口（其 `findMachineAgentNamesByIds`
 * 是读 DB 替身的真实实现，与迁移前一致）；无前次绑定时抛错，避免用例静默拿到 `undefined`。
 */
export function stubMachineRegistryPort(overrides: Partial<MachineRegistryPort>): void {
  if (!machineRegistryPortStubbed) {
    savedMachineRegistryPort = tryGetMachineRegistryPort();
    machineRegistryPortStubbed = true;
  }
  resetMachineRegistryPortForTest();
  const fallback = savedMachineRegistryPort;
  bindMachineRegistryPort({
    registerMachine: fallback?.registerMachine ?? (() => unconfiguredMachineRegistryMethod("registerMachine")),
    disconnectMachine: fallback?.disconnectMachine ?? (() => unconfiguredMachineRegistryMethod("disconnectMachine")),
    handleHeartbeat: fallback?.handleHeartbeat ?? (() => unconfiguredMachineRegistryMethod("handleHeartbeat")),
    startHeartbeat: fallback?.startHeartbeat ?? (() => unconfiguredMachineRegistryMethod("startHeartbeat")),
    stopHeartbeat: fallback?.stopHeartbeat ?? (() => unconfiguredMachineRegistryMethod("stopHeartbeat")),
    findMachineAgentNamesByIds:
      fallback?.findMachineAgentNamesByIds ?? (() => unconfiguredMachineRegistryMethod("findMachineAgentNamesByIds")),
    ...overrides,
  });
}

/** 还原前一次绑定的 Machine 注册端口。 */
export function resetMachineRegistryPortStub(): void {
  if (!machineRegistryPortStubbed) return;
  resetMachineRegistryPortForTest();
  if (savedMachineRegistryPort) bindMachineRegistryPort(savedMachineRegistryPort);
  savedMachineRegistryPort = null;
  machineRegistryPortStubbed = false;
}

/** 读取已绑定端口；未绑定时返回 `null`（同上，不做 fail-fast）。 */
function tryGetMachineRegistryPort(): MachineRegistryPort | null {
  try {
    return getMachineRegistryPort();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行 port 的替身（1.4 W3b）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用「真实入口 + 给定覆盖」装配运行 port 的替身。
 *
 * 生产消费方一律经 `getBoundAgentRuntime()` 取运行能力（1.4 W3b），因此「替换运行能力」的唯一缝
 * 就是绑定本身：路由、编排层、资源包拿到的是同一份绑定，不需要各自维护 deps 对象——那正是
 * `/web/instances` 的 `setWebInstanceRouteDeps` 被删除的原因。
 *
 * 未覆盖的方法保留真实实现；真实实现内部的仓储与宿主端口仍按各自的替身生效（宿主 preload 已经把
 * 环境仓储等换成转发 Proxy），所以这里只覆盖「本用例要断言或要绕开」的那几个方法即可。
 * `session` 是嵌套对象，需要替换数据面时整体传入。
 *
 * 与其它 `bind*Port` 同口径：**一次装配**。用例结束必须 `resetAgentRuntimePort()`，否则绑定是
 * 进程级的，会泄漏到同进程的后续测试文件。
 */
export function stubAgentRuntimePort(overrides: Partial<AgentRuntime>): void {
  resetAgentRuntimeForTest();
  bindAgentRuntime({ ...createAgentRuntime(), ...overrides });
}

/** 复位运行 port 绑定并回到默认的真实入口，供用例 `afterEach` 调用。 */
export function resetAgentRuntimePort(): void {
  resetAgentRuntimeForTest();
  bindAgentRuntime(createAgentRuntime());
}

// ─────────────────────────────────────────────────────────────────────────────
// 启动参数组装 port 的替身（1.4 W4b）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 启动参数组装 port 的替身：返回一份字段齐全但内容无关的 `AgentLaunchSpec`。
 *
 * 内容是无关的，因为组装规则的 owner 是 `@fenix/agent-config`（`agent-launch-spec-*.test.ts` 逐条
 * 覆盖）；本包用例经这个 port 只是为了走完启动链路，断言的是**编排语义**（并发预留的可见性窗口、
 * 失败回滚、节点归属、机器缓存预热）。真实组装器未装配时 port fail-fast（W4b 删掉了过渡默认实现），
 * 因此凡是走到 `buildAgentLaunchSpecForCore` 的包内用例都必须先装配它——装配**一次**，与其它
 * `bind*Port` 同口径。
 *
 * 与 `stubAgentRuntimePort` 的差别在于复位方式：这里把复位挂到 `resetAllStubs()`，因为
 * `initializeAgentRuntimeModuleConfig()` 的 `beforeEach` 已经会复位全部替身，漏挂复位会让「单跑绿、
 * 全量跑红」。需要断言「请求被怎么组装」时用 `overrides` 覆盖对应动词。
 */
export function stubAgentLaunchSpecPort(overrides: Partial<AgentLaunchSpecPort> = {}): void {
  resetAgentLaunchSpecPort();
  bindAgentLaunchSpecPort({
    buildAgentLaunchSpec: async (request) => buildInertLaunchSpec(request),
    buildMinimalAgentLaunchSpec: async (request) => buildInertLaunchSpec(request),
    ...overrides,
  });
}

/**
 * 组装一份只满足类型、不被任何断言消费的 spec。
 *
 * `apiKey` 留空串而不是写一个像样的假密钥：它是「密钥不得写入源码」红线在测试代码里的落点，
 * 空值也让「用例其实在依赖这份内容」当场暴露（真实 engine 拿到空密钥会立刻失败）。
 */
function buildInertLaunchSpec(request: {
  environmentId: string;
  organizationId: string;
  ownerUserId: string;
}): AgentLaunchSpec {
  return {
    organizationId: request.organizationId,
    userId: request.ownerUserId,
    environmentId: request.environmentId,
    agent: { name: "stub-agent" },
    model: {
      provider: "stub-provider",
      protocol: "openai",
      baseUrl: "http://stub.invalid",
      apiKey: "",
      model: "stub-model",
    },
    skills: [],
    mcpServers: [],
  };
}

registerStubResetter(resetAgentLaunchSpecPort);

// 三组宿主注入面替身的复位（§1.7 收尾）：与 `stubAgentLaunchSpecPort` 同口径挂到 `resetAllStubs()`，
// 用例只需在 `beforeEach` 调 `initializeAgentRuntimeModuleConfig()`；漏挂复位会让替身泄漏到同进程的后续
// 测试文件（症状是「单独跑通过、全量跑失败」，且失败点与泄漏源相隔很远）。
registerStubResetter(resetEnvironmentRepoStubForTest);
registerStubResetter(resetCoreRuntimeFacadeStub);
registerStubResetter(resetMachineRegistryPortStub);
