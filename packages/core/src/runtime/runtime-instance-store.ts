import type {
  AgentLaunchSpec,
  EnginePlugin,
  EngineRelayHandle,
  EngineRuntime,
} from "@mothership/plugin-sdk";
import { createCoreRuntimeError } from "../errors/core-runtime-error";
import type {
  RuntimeInstanceRecord,
  RuntimeInstanceSnapshot,
  RuntimeInstanceStatus,
} from "../types/runtime-instance";

/**
 * 为 store 提供可注入时间源，方便测试稳定断言时间戳。
 */
export type RuntimeClock = () => Date;

/**
 * 与实例关联的 runtime 缓存条目。
 */
export interface RuntimeInstanceRuntimeEntry {
  /** 该实例绑定的 engine plugin 定义。 */
  plugin: EnginePlugin;
  /** 该实例对应的 engine runtime 句柄。 */
  runtime: EngineRuntime;
  /** 当前缓存的 relay 连接；尚未连接时为空。 */
  relay: EngineRelayHandle | null;
}

/**
 * 创建编排层实例记录所需的输入。
 */
export interface CreateRuntimeInstanceRecordInput {
  /** Core 侧生成的实例唯一标识。 */
  instanceId: string;
  /** 目标 engine 类型，对应 plugin `meta.id`。 */
  engineType: string;
  /** 本次实例要调度到的 node 标识。 */
  nodeId: string;
  /** 提供给 engine prepare 阶段的启动配置。 */
  launchSpec: AgentLaunchSpec;
}

/**
 * 更新编排层实例记录时可变更的字段。
 */
export interface UpdateRuntimeInstanceRecordInput {
  /** 需要推进到的新状态；未传则保持原值。 */
  status?: RuntimeInstanceStatus;
  /** 是否已建立 relay 连接。 */
  relayConnected?: boolean;
  /** 当前错误信息，仅 `error` 状态下保留。 */
  errorMessage?: string;
}

/**
 * Core 编排层维护实例状态与 runtime 缓存的最小持久面。
 */
export interface RuntimeInstanceStore {
  /** 创建一条新的实例记录，重复 `instanceId` 时抛错。 */
  create(input: CreateRuntimeInstanceRecordInput): RuntimeInstanceSnapshot;
  /** 按实例 ID 读取快照；不存在时返回 `null`。 */
  get(instanceId: string): RuntimeInstanceSnapshot | null;
  /** 按实例 ID 读取快照；不存在时抛出 `INSTANCE_NOT_FOUND`。 */
  require(instanceId: string): RuntimeInstanceSnapshot;
  /** 返回全部实例快照列表。 */
  list(): RuntimeInstanceSnapshot[];
  /** 更新实例状态字段，并刷新 `updatedAt`。 */
  update(
    instanceId: string,
    input: UpdateRuntimeInstanceRecordInput,
  ): RuntimeInstanceSnapshot;
  /** 为已存在实例绑定 plugin/runtime/relay 缓存。 */
  attachRuntime(
    instanceId: string,
    runtimeEntry: RuntimeInstanceRuntimeEntry,
  ): RuntimeInstanceRuntimeEntry;
  /** 读取实例的 runtime 缓存；不存在时返回 `null`。 */
  getRuntimeEntry(instanceId: string): RuntimeInstanceRuntimeEntry | null;
  /** 写入 relay 缓存，并同步把实例标记为已连接 relay。 */
  setRelay(
    instanceId: string,
    relay: EngineRelayHandle,
  ): RuntimeInstanceRuntimeEntry;
  /** 清空 relay 缓存，并同步把实例标记为未连接 relay。 */
  clearRelay(instanceId: string): RuntimeInstanceRuntimeEntry | null;
  /** 删除实例记录及其 runtime 缓存。 */
  delete(instanceId: string): boolean;
}

/**
 * 深拷贝 launchSpec，避免调用方改写快照后污染内部状态。
 */
function cloneLaunchSpec(launchSpec: AgentLaunchSpec): AgentLaunchSpec {
  return {
    ...launchSpec,
    env: launchSpec.env ? { ...launchSpec.env } : undefined,
    agent: { ...launchSpec.agent },
    model: { ...launchSpec.model },
    skills: launchSpec.skills.map((skill) => ({ ...skill })),
    mcpServers: launchSpec.mcpServers.map((server) =>
      server.type === "stdio"
        ? {
            ...server,
            args: server.args ? [...server.args] : undefined,
            env: server.env ? { ...server.env } : undefined,
          }
        : {
            ...server,
            headers: server.headers ? { ...server.headers } : undefined,
            oauth: server.oauth ? { ...server.oauth } : server.oauth,
          },
    ),
  };
}

/**
 * 把内部可变记录转换成对外只读快照。
 */
function toSnapshot(record: RuntimeInstanceRecord): RuntimeInstanceSnapshot {
  return {
    ...record,
    launchSpec: cloneLaunchSpec(record.launchSpec),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/**
 * 复制 runtime 缓存条目，避免外部直接持有 store 内部对象引用。
 */
function cloneRuntimeEntry(
  entry: RuntimeInstanceRuntimeEntry,
): RuntimeInstanceRuntimeEntry {
  return {
    plugin: entry.plugin,
    runtime: entry.runtime,
    relay: entry.relay,
  };
}

/**
 * 创建默认的内存版 runtime instance store。
 */
export function createRuntimeInstanceStore(options?: {
  now?: RuntimeClock;
}): RuntimeInstanceStore {
  const records = new Map<string, RuntimeInstanceRecord>();
  const runtimeEntries = new Map<string, RuntimeInstanceRuntimeEntry>();
  const now = options?.now ?? (() => new Date());

  return {
    /**
     * 创建实例初始记录，并把状态固定为 `created`。
     */
    create(input) {
      if (records.has(input.instanceId)) {
        throw createCoreRuntimeError(
          "INSTANCE_ALREADY_EXISTS",
          `Runtime instance already exists: ${input.instanceId}`,
          { instanceId: input.instanceId },
        );
      }

      const timestamp = now();
      const record: RuntimeInstanceRecord = {
        instanceId: input.instanceId,
        engineType: input.engineType,
        nodeId: input.nodeId,
        status: "created",
        launchSpec: cloneLaunchSpec(input.launchSpec),
        relayConnected: false,
        errorMessage: undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      records.set(record.instanceId, record);
      return toSnapshot(record);
    },

    /**
     * 返回实例快照副本，不暴露内部可变记录。
     */
    get(instanceId) {
      const record = records.get(instanceId);
      return record ? toSnapshot(record) : null;
    },

    /**
     * 返回实例快照副本；缺失实例时抛出具名错误。
     */
    require(instanceId) {
      const record = records.get(instanceId);
      if (!record) {
        throw createCoreRuntimeError(
          "INSTANCE_NOT_FOUND",
          `Runtime instance not found: ${instanceId}`,
          { instanceId },
        );
      }

      return toSnapshot(record);
    },

    /**
     * 返回当前全部实例的快照列表。
     */
    list() {
      return [...records.values()].map(toSnapshot);
    },

    /**
     * 更新实例状态与附属字段，并统一刷新更新时间戳。
     */
    update(instanceId, input) {
      const current = records.get(instanceId);
      if (!current) {
        throw createCoreRuntimeError(
          "INSTANCE_NOT_FOUND",
          `Runtime instance not found: ${instanceId}`,
          { instanceId },
        );
      }

      const nextStatus = input.status ?? current.status;
      const nextRecord: RuntimeInstanceRecord = {
        ...current,
        status: nextStatus,
        relayConnected: input.relayConnected ?? current.relayConnected,
        errorMessage:
          nextStatus === "error"
            ? input.errorMessage ?? current.errorMessage
            : undefined,
        updatedAt: now(),
      };

      records.set(instanceId, nextRecord);
      return toSnapshot(nextRecord);
    },

    /**
     * 为实例绑定 runtime 缓存，供 orchestrator 复用真实句柄。
     */
    attachRuntime(instanceId, runtimeEntry) {
      if (!records.has(instanceId)) {
        throw createCoreRuntimeError(
          "INSTANCE_NOT_FOUND",
          `Runtime instance not found: ${instanceId}`,
          { instanceId },
        );
      }

      const entry = cloneRuntimeEntry(runtimeEntry);
      runtimeEntries.set(instanceId, entry);
      return cloneRuntimeEntry(entry);
    },

    /**
     * 返回 runtime 缓存副本；未绑定时返回 `null`。
     */
    getRuntimeEntry(instanceId) {
      const entry = runtimeEntries.get(instanceId);
      return entry ? cloneRuntimeEntry(entry) : null;
    },

    /**
     * 写入新 relay 句柄，并同步实例的 relay 连接状态。
     */
    setRelay(instanceId, relay) {
      const currentEntry = runtimeEntries.get(instanceId);
      if (!currentEntry) {
        throw createCoreRuntimeError(
          "INSTANCE_NOT_FOUND",
          `Runtime entry not found: ${instanceId}`,
          { instanceId },
        );
      }

      runtimeEntries.set(instanceId, {
        ...currentEntry,
        relay,
      });
      this.update(instanceId, { relayConnected: true });
      return cloneRuntimeEntry(runtimeEntries.get(instanceId)!);
    },

    /**
     * 清除 relay 缓存，并同步实例的 relay 连接状态。
     */
    clearRelay(instanceId) {
      const currentEntry = runtimeEntries.get(instanceId);
      if (!currentEntry) {
        return null;
      }

      runtimeEntries.set(instanceId, {
        ...currentEntry,
        relay: null,
      });
      this.update(instanceId, { relayConnected: false });
      return cloneRuntimeEntry(runtimeEntries.get(instanceId)!);
    },

    /**
     * 删除实例记录与 runtime 缓存；返回是否实际删除了记录。
     */
    delete(instanceId) {
      const deletedRecord = records.delete(instanceId);
      runtimeEntries.delete(instanceId);
      return deletedRecord;
    },
  };
}
