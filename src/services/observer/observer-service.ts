// src/services/observer/observer-service.ts
// ObserverService：请求驱动的聚合面（文档 §3.1）。
// - provider 注册表：kind → KindProvider，可独立注册/摘除（随时可回滚）；
// - tree(kind)/list(kind)：现场收集 + 组装，未注册的 kind 抛 ObserverKindNotFoundError；
// - deps 注入 seam：沿用 setExternalRelayDeps / setChatChannelBootstrapDeps 模式，
//   测试通过 setObserverServiceDeps(fake) 注入来源与权威回查，不 mock.module。
//
// 默认 deps 惰性绑定（D8）：
// - chat-channel-bootstrap 必须动态 import()：静态导入会把 ioredis/yjs 拖进测试模块图；
// - environmentRepo 经 preload Proxy 调用时解析（setup-mocks.ts 头注释记载过同款事故：
//   绑定一次引用会固化导致 stub 失效），因此 getEnvironment 每次调用都经属性访问转发。

import { config } from "../../config";
import { type EnvironmentRecord, environmentRepo, findUsersBasicInfoByIds, organizationRepo } from "../../repositories";
import { findAgentConfigNamesByIds } from "../../repositories/agent-config";
import { findMachineNamesByIds } from "../../repositories/machine-repository";
import { listAcpConnections } from "../../transport/acp-ws-handler";
import {
  type ExternalRelayConnectionSnapshot,
  listExternalRelayEntries as listExternalRelayEntriesModule,
} from "../../transport/relay/external-relay";
import type { AcpConnectionSnapshot } from "../../types/store";
import { getAgentConfigById as getAgentConfigByIdFromConfig } from "../config/index";
import { globalInstanceRegistry } from "../instance-registry";
import { acpLinkProvider } from "./providers/acp-link";
import { buildRelationTree } from "./relation-tree";
import type {
  ChatClientSnapshot,
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
  listChatClients: () => readonly ChatClientSnapshot[] | Promise<readonly ChatClientSnapshot[]>;
  getEnvironment: (id: string) => Promise<EnvironmentRecord | null | undefined>;
  getAgentConfigById: (id: string) => Promise<{ machineId: string | null } | null | undefined>;
  getDefaultMachineId: () => string | null;
  // ── name(id) 展示名称解析（文档 §4 names；只读、即用即弃，不缓存）──
  /** instanceId → 实例补充信息（environmentId + 序号），未运行/未知返回 undefined */
  getInstanceSupplement: (instanceId: string) => { environmentId: string; instanceNumber: number } | undefined;
  listOrganizationNamesByIds: (ids: string[]) => Promise<Map<string, string>>;
  listUserNamesByIds: (ids: string[]) => Promise<Map<string, string>>;
  listAgentConfigNamesByIds: (ids: string[]) => Promise<Map<string, string>>;
  listMachineNamesByIds: (ids: string[]) => Promise<Map<string, string>>;
}

/** 默认 deps：来源快照全部走真实只读 getter；chat-channel-bootstrap 动态加载（D8）。 */
const defaultDeps: ObserverServiceDeps = {
  listAcpWsConnections: () => listAcpConnections(),
  listExternalRelayEntries: () => listExternalRelayEntriesModule(),
  listChatClients: async () => {
    // 惰性加载：chat-channel-bootstrap 会拖入 ioredis/yjs 重依赖，测试注入 fake 时不应加载
    const { getChatChannelController } = await import("../chat-channel-bootstrap");
    const out: ChatClientSnapshot[] = [];
    getChatChannelController().registry.forEachClientEntry((wsId, client) => {
      out.push({
        wsId,
        userId: client.userId,
        agentId: client.agentId,
        instanceId: client.instanceId,
        rcsSessionId: client.rcsSessionId,
        acpSessionId: client.acpSessionId,
        openTime: client.openTime,
      });
    });
    return out;
  },
  // 调用时经 preload Proxy 属性访问转发到当前 stub，stub 才能生效（setup-mocks 注释）
  getEnvironment: (id) => environmentRepo.getById(id),
  getAgentConfigById: (id) => getAgentConfigByIdFromConfig(id),
  getDefaultMachineId: () => config.defaultMachineId ?? null,
  getInstanceSupplement: (instanceId) => globalInstanceRegistry.get(instanceId),
  listOrganizationNamesByIds: (ids) => organizationRepo.listNamesByIds(ids),
  listUserNamesByIds: async (ids) => {
    const rows = await findUsersBasicInfoByIds(ids);
    return new Map(rows.map((row) => [row.id, row.name]));
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
   * instance 名 = environment 名 + 实例序号：instanceId 经 instance registry 只读回查
   * environmentId，再经 environment 权威表取名称。
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
    for (const instanceId of idsFor("instanceId")) {
      const supplement = deps.getInstanceSupplement(instanceId);
      if (!supplement) continue;
      const env = await deps.getEnvironment(supplement.environmentId);
      if (env?.name) instanceNames.set(instanceId, `${env.name} #${supplement.instanceNumber}`);
    }

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
