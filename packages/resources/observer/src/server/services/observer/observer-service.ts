// src/services/observer/observer-service.ts
// ObserverService：请求驱动的聚合面（文档 §3.1）。
// - provider 注册表：kind → KindProvider，可独立注册/摘除（随时可回滚）；
// - tree(kind)/list(kind)：现场收集 + 组装，未注册的 kind 抛 ObserverKindNotFoundError；
// - deps 注入 seam：沿用 setExternalRelayDeps / setChatChannelBootstrapDeps 模式，
//   测试通过 setObserverServiceDeps(fake) 注入来源与权威回查，不 mock.module。
//
// 默认 deps 全部经运行 port 的只读观测面取（1.4 W6b）：来源快照、实例名回读、环境权威回查
// 都由 `getBoundAgentRuntime().observe` 提供，不再直接 import 本包的内部登记表与仓储。
// 观测面每次调用现场取数（`getBoundAgentRuntime()` 经属性访问转发，preload Proxy 的 stub 因此
// 仍然生效——setup-mocks.ts 头注释记载过「绑定一次引用会固化导致 stub 失效」的事故）。
// chat-channel-bootstrap 的重依赖（ioredis / yjs）由观测面在方法内动态 import，本文件不感知。

import { findAgentConfigNamesByIds, getAgentConfigById } from "@fenix/agent-config/server";
import {
  type EnvironmentRecord,
  type ExternalRelayConnectionSnapshot,
  getBoundAgentRuntime,
} from "@fenix/agent-runtime/runtime";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { findMachineNamesByIds, getMachineConfig } from "@fenix/resource-machine/server";
import { acpLinkProvider } from "./providers/acp-link";
import { buildRelationTree } from "./relation-tree";
import type {
  AcpConnectionSnapshot,
  ChatClientConnectionSnapshot,
  KindProvider,
  Observation,
  ObservationNames,
  ObserverContext,
  RelationTreeView,
} from "./types";

/** 未注册 kind 的查询错误（路由映射 404）。 */
export class ObserverKindNotFoundError extends Error {
  constructor(kind: string) {
    super(`Observer kind not registered: ${kind}`);
    this.name = "ObserverKindNotFoundError";
  }
}

/** 测试注入 seam（沿用 setExternalRelayDeps / setChatChannelBootstrapDeps 模式）。 */
export interface ObserverServiceDeps {
  listAcpWsConnections: () => readonly AcpConnectionSnapshot[];
  listExternalRelayEntries: () => readonly ExternalRelayConnectionSnapshot[];
  listChatClients: () => readonly ChatClientConnectionSnapshot[] | Promise<readonly ChatClientConnectionSnapshot[]>;
  getEnvironment: (id: string) => Promise<EnvironmentRecord | null | undefined>;
  getAgentConfigById: (id: string) => Promise<{ machineId: string | null } | null | undefined>;
  getDefaultMachineId: () => string | null;
  // ── name(id) 展示名称解析（文档 §4 names；只读、即用即弃，不缓存）──
  /** instanceUid → 持久实例名称；未知实例返回 undefined。 */
  getInstanceName: (instanceUid: string) => Promise<string | undefined>;
  // 组织名与用户名来自 `IdentityDirectory`，其契约只承诺只读投影，故这里也按 `ReadonlyMap`
  // 声明（`Map` 天然满足它，测试 fixture 不受影响）；下方只经 `Object.fromEntries` 读取。
  listOrganizationNamesByIds: (ids: string[]) => Promise<ReadonlyMap<string, string>>;
  listUserNamesByIds: (ids: string[]) => Promise<ReadonlyMap<string, string>>;
  listAgentConfigNamesByIds: (ids: string[]) => Promise<Map<string, string>>;
  listMachineNamesByIds: (ids: string[]) => Promise<Map<string, string>>;
}

/** 默认 deps：全部经运行 port 的只读观测面取（1.4 W6b），本包不再自持来源接线。 */
const defaultDeps: ObserverServiceDeps = {
  listAcpWsConnections: () => getBoundAgentRuntime().observe.listAcpConnections(),
  listExternalRelayEntries: () => getBoundAgentRuntime().observe.listExternalRelayConnections(),
  listChatClients: () => getBoundAgentRuntime().observe.listChatClients(),
  // 调用时经属性访问转发到当前绑定，用例换绑替身才能生效（setup-mocks 注释记载过「绑定一次引用
  // 会固化导致 stub 失效」的事故）：故这里写 `getBoundAgentRuntime().observe.x()` 而不是把方法摘出来存。
  getEnvironment: (id) => getBoundAgentRuntime().observe.getEnvironmentRecord(id),
  getAgentConfigById: (id) => getAgentConfigById(id),
  // 兜底 machine 是 Machine 模块的配置字段（`RCS_DEFAULT_MACHINE_ID` 的 owner 在那边），这里读唯一来源
  // 而不是在观察模块的配置里复制一份同名值：两处各持一份必然漂移。请求时读取——模块加载期宿主可能尚未
  // 完成基础设施初始化。
  getDefaultMachineId: () => getMachineConfig().defaultMachineId ?? null,
  getInstanceName: (instanceUid) => getBoundAgentRuntime().observe.getInstanceName(instanceUid),
  listOrganizationNamesByIds: (ids) => getIdentityDirectory().listOrganizationNames(ids),
  listUserNamesByIds: async (ids) => {
    const users = await getIdentityDirectory().listUserDisplayInfo(ids);
    return new Map([...users].map(([id, user]) => [id, user.name]));
  },
  listAgentConfigNamesByIds: (ids) => findAgentConfigNamesByIds(ids),
  listMachineNamesByIds: (ids) => findMachineNamesByIds(ids),
};

let deps: ObserverServiceDeps = defaultDeps;

/** 覆盖 Observer 依赖（部分覆盖，未覆盖字段回落默认）；传 null 恢复默认。 */
export function setObserverServiceDeps(overrides: Partial<ObserverServiceDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** 恢复默认 deps（测试 afterEach 复位，resetAllStubs 不感知 observer deps，见计划 §6.4）。 */
export function resetObserverServiceDeps(): void {
  deps = defaultDeps;
}

export class ObserverService {
  private readonly providers = new Map<string, KindProvider>();

  /** 单例构造时注册 acp-link Provider（文档 §3.1）。 */
  constructor() {
    this.register(acpLinkProvider);
  }

  /** kind → Provider 路由。 */
  provider(kind: string): KindProvider | undefined {
    return this.providers.get(kind);
  }

  /** 独立注册 Provider。 */
  register(provider: KindProvider): void {
    this.providers.set(provider.kind, provider);
  }

  /** 独立摘除 Provider（回滚）。 */
  unregister(kind: string): void {
    this.providers.delete(kind);
  }

  /** 现场收集并组装关系树。 */
  async tree(kind: string): Promise<RelationTreeView> {
    const provider = this.provider(kind);
    if (!provider) throw new ObserverKindNotFoundError(kind);
    const observations = await provider.collect(this.buildContext());
    const names = await this.resolveNames(observations);
    return buildRelationTree(kind, observations, names);
  }

  /**
   * 现场收集各角色 id → 可读名称字典（name(id) 展示用，文档 §4 names）。
   * 名称只用于展示，缺失 id 不进字典（前端回退显示原始 id）；查询结果即用即弃、不缓存（§0.3）。
   * instance 名来自持久 Agent Instance，不依赖 runtime registry 或环境内序号。
   */
  private async resolveNames(observations: Observation[]): Promise<ObservationNames> {
    const byRole = new Map<string, Set<string>>();
    for (const observation of observations) {
      for (const { role, id } of observation.entityIds) {
        if (role === "linkId") continue; // 叶子 id 即业务 id，无需名称
        let set = byRole.get(role);
        if (!set) {
          set = new Set();
          byRole.set(role, set);
        }
        set.add(id);
      }
    }
    const idsFor = (role: string) => [...(byRole.get(role) ?? [])];

    const [orgNames, userNames, agentNames, machineNames] = await Promise.all([
      deps.listOrganizationNamesByIds(idsFor("organizationId")),
      deps.listUserNamesByIds(idsFor("userId")),
      deps.listAgentConfigNamesByIds(idsFor("agentConfigId")),
      deps.listMachineNamesByIds(idsFor("machineId")),
    ]);

    const instanceNames = new Map<string, string>();
    await Promise.all(
      idsFor("instanceId").map(async (instanceUid) => {
        const name = await deps.getInstanceName(instanceUid);
        if (name) instanceNames.set(instanceUid, name);
      }),
    );

    return {
      organizationId: Object.fromEntries(orgNames),
      userId: Object.fromEntries(userNames),
      agentConfigId: Object.fromEntries(agentNames),
      instanceId: Object.fromEntries(instanceNames),
      machineId: Object.fromEntries(machineNames),
    };
  }

  /** 现场收集并返回平坦行。 */
  async list(kind: string): Promise<Observation[]> {
    const provider = this.provider(kind);
    if (!provider) throw new ObserverKindNotFoundError(kind);
    return provider.collect(this.buildContext());
  }

  private buildContext(): ObserverContext {
    return {
      sources: {
        acpWs: () => deps.listAcpWsConnections(),
        externalRelay: () => deps.listExternalRelayEntries(),
        chatClients: () => deps.listChatClients(),
      },
      getEnvironment: (id) => deps.getEnvironment(id),
      // machine 解析链：agentConfig.machineId → defaultMachineId → null（D5 / §4.5）。
      // 不复用 getRemoteMachineId：它带 file-ws 连通性检查且可抛 422/503，不适合纯观察。
      resolveHostMachineId: async (env) => {
        if (env.agentConfigId) {
          const agentCfg = await deps.getAgentConfigById(env.agentConfigId);
          if (agentCfg?.machineId) return agentCfg.machineId;
        }
        return deps.getDefaultMachineId();
      },
      defaultMachineId: deps.getDefaultMachineId(),
    };
  }
}

/** 模块单例（构造时注册 acpLinkProvider）。 */
export const observerService = new ObserverService();
