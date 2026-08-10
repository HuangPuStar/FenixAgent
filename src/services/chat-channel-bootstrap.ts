// src/services/chat-channel-bootstrap.ts
// Chat 域宿主桥接层（C7）：包内 ChatChannelDependencies 的宿主实现装配与单例缓存。
//
// 复制编排域桥接模式（orchestration-bootstrap.ts / orchestration-instance.ts）：
// - _deps 惰性引用宿主模块单例，setChatChannelBootstrapDeps(null) 供测试注入 fake
//   （测试禁止直接 mock.module，CLAUDE.md 质量红线）；
// - getChatChannelController 惰性构造并缓存单例，resetChatChannelBootstrap 仅用于测试。
//
// 单例缓存是必要的：SessionChannel 构造时会向 DocManager 注册权限请求回调（单槽位
// 装配点），重复构造会覆盖前者导致权限超时迁移失效，因此一个进程内至多一个控制器。

import type { ActionErrorCode, ChatChannelDependencies } from "@fenix/chat-channel";
import {
  ChatChannelController,
  CommandExecutionError,
  clearSessionDocContent,
  persistYjsClearedSnapshotWithCas,
} from "@fenix/chat-channel";
import { log, error as logError } from "@fenix/logger";
import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import {
  findModelPresetRowsByEngineId,
  getAgentModelPreset,
  getModelPresetRowsByIds,
} from "../repositories/agent-config";
import { environmentRepo } from "../repositories/environment";
import { connectAgentRelay } from "../transport/agent-relay";
import { markInstanceRelayAttached, markInstanceRelayDetached, touchInstanceActivity } from "./acp-idle-monitor";
import { getRedisConnection } from "./cache";
import { classifyPermanentSpawnFailure, isMachineOfflineError } from "./chat-channel-error-classify";
import { docManager } from "./doc-manager-instance";
import { ensureRunning } from "./instance";
import { parseInstanceSessionId } from "./instance-session";
import { terminateLocalDeadInstance } from "./orchestration-instance";
import { resolveWorkspacePath } from "./workspace-resolver";

type ChatChannelBootstrapDeps = {
  environmentRepo: typeof environmentRepo;
  resolveWorkspacePath: typeof resolveWorkspacePath;
  ensureRunning: typeof ensureRunning;
  connectAgentRelay: typeof connectAgentRelay;
  markInstanceRelayAttached: typeof markInstanceRelayAttached;
  markInstanceRelayDetached: typeof markInstanceRelayDetached;
  touchInstanceActivity: typeof touchInstanceActivity;
  terminateLocalDeadInstance: typeof terminateLocalDeadInstance;
  getRedisConnection: typeof getRedisConnection;
  docManager: typeof docManager;
  parseInstanceSessionId: typeof parseInstanceSessionId;
  isMachineOfflineError: typeof isMachineOfflineError;
  classifyPermanentSpawnFailure: typeof classifyPermanentSpawnFailure;
  log: typeof log;
  logError: typeof logError;
  maxClients: () => number;
};

const defaultDeps: ChatChannelBootstrapDeps = {
  environmentRepo,
  resolveWorkspacePath,
  ensureRunning,
  connectAgentRelay,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
  terminateLocalDeadInstance,
  getRedisConnection,
  docManager,
  parseInstanceSessionId,
  isMachineOfflineError,
  classifyPermanentSpawnFailure,
  log,
  logError,
  maxClients: () => parseInt(process.env.YJS_MAX_CLIENTS || "", 10) || 200,
};

let deps: ChatChannelBootstrapDeps = defaultDeps;

/** 测试用：覆盖桥接层依赖（部分覆盖，未覆盖字段回落默认实现）；传 null 恢复默认。 */
export function setChatChannelBootstrapDeps(overrides: Partial<ChatChannelBootstrapDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/**
 * 以 CAS 方式把清空后的 Session Doc 快照持久化到 Redis（会话切换前的并发安全清理）。
 * Redis 冲突重试耗尽时抛错，由调用方保留诊断上下文（错误消息不包含会话内容）。
 */
export async function persistClearedSessionSnapshot(
  redis: Redis | Cluster,
  redisKey: string,
  ydoc: Y.Doc,
): Promise<void> {
  const persisted = await persistYjsClearedSnapshotWithCas(
    redis,
    redisKey,
    Y.encodeStateAsUpdate(ydoc),
    clearSessionDocContent,
  );
  if (!persisted) throw new Error("Redis snapshot conflict retries exhausted");
}

function buildChatChannelDependencies(): ChatChannelDependencies {
  return {
    docManager: deps.docManager,
    // 路由已用 authContext 验证组织成员资格；这里仅作为纵深防御，不能把组织环境
    // 误当成个人环境（无 owner 的历史/桥接环境可继续访问）。
    authorizeEnvironment: (userId, environment) =>
      environment.organizationId !== null && environment.organizationId !== undefined
        ? true
        : !environment.userId || environment.userId === userId,
    getEnvironment: deps.environmentRepo.getById.bind(deps.environmentRepo),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    // I4 说明：YJS 前端 Chat 走 Chat 域重构（ChatChannelController），继续复用
    // ensureRunning 的实例复用语义（先复用运行实例、仅新建时检查并发配额，场景 K）；
    // spawn 分支内部委托 spawnInstanceViaController 创建独立实例并负责销毁。
    ensureRunning: (userId, agentId, mode, instanceNumber) => deps.ensureRunning(userId, agentId, mode, instanceNumber),
    connectAgentRelay: deps.connectAgentRelay,
    markRelayAttached: deps.markInstanceRelayAttached,
    markRelayDetached: deps.markInstanceRelayDetached,
    touchInstanceActivity: deps.touchInstanceActivity,
    terminateLocalDeadInstance: (instanceId) => {
      // orchestration-instance 的回收是异步的；relay 断链路径不等待回收完成，
      // 避免阻塞消息处理循环（回收失败由该函数内部日志保留诊断上下文）。
      void deps.terminateLocalDeadInstance(instanceId);
    },
    prepareClearSessionSnapshot: async (connection) => {
      const redis = deps.getRedisConnection();
      if (!redis) return;
      const sessionDoc = await deps.docManager.openSession(
        connection.userId,
        connection.agentId,
        connection.rcsSessionId,
      );
      await persistClearedSessionSnapshot(redis, `yjs:session:${connection.rcsSessionId}`, sessionDoc.ydoc);
    },
    resolveInstanceNumberFromSession: async (sessionId) => {
      // 从确定性会话 ID（ses_inst_{environmentId}_{instanceNumber}）解析实例编号；
      // agent_session 表已废弃，不再查 DB 标题。
      const parsed = deps.parseInstanceSessionId(sessionId);
      // message 不得包含 sessionId：其可含 envId 等标识，进入日志即构成敏感信息泄漏
      if (!parsed) throw new Error("Invalid instance session id");
      return parsed.instanceNumber;
    },
    isMachineOffline: deps.isMachineOfflineError,
    classifyPermanentSpawnFailure: deps.classifyPermanentSpawnFailure,
    maxClients: deps.maxClients,
    log: deps.log,
    reportError: deps.logError,
    // 预选模型注入（设计 §5.1 服务端权威）：session/new、load、resume 时用
    // agent_config.modelIds 覆盖引擎自报的 availableModels（value=引擎标识
    // model.modelId，name=displayName），引擎与前端天然只见预选范围
    resolvePresetModelState: async (rcsSessionId, agentId) => {
      try {
        return await resolvePresetModelState(agentId);
      } catch (err) {
        // 预选解析失败不阻塞会话建立：回退引擎自报（与 launch 过滤失效项同语义）
        deps.logError(
          `[chat-bootstrap] resolvePresetModelState failed: rcsSessionId=${rcsSessionId}, agentId=${agentId}`,
          err,
        );
        return null;
      }
    },
    // 切换模型拦截（设计 §5.2 保守拒绝）：engine 标识反查 UUID 校验 ∈ 预选列表；
    // modelIds===null（未配置预选）的存量 agent 放行，保持向后兼容
    validateSetSessionModel: async (connection, modelId) => {
      const env = await deps.environmentRepo.getById(connection.agentId);
      if (!env?.agentConfigId) return;
      const preset = await getAgentModelPreset(env.agentConfigId);
      if (!preset || preset.modelIds === null) return;
      let candidates: Array<{ id: string; modelId: string }>;
      if (preset.modelIds.length === 0) {
        // 单模型 agent（modelIds=[]）：候选行仅默认模型（引擎标识反查无意义，
        // 直接按默认模型 UUID 读取），其余模型保守拒绝
        candidates = preset.modelId ? await getModelPresetRowsByIds([preset.modelId]) : [];
      } else {
        // 引擎标识反查 UUID（model.modelId 跨 provider 可能重复，返回全部候选）
        candidates = await findModelPresetRowsByEngineId(modelId);
      }
      const rejection = evaluateModelSwitchPermission(preset, candidates, modelId);
      if (rejection) {
        // 错误消息仅含 modelId 标识与稳定错误码，不泄露内部实现
        throw new CommandExecutionError(rejection.code, rejection.message, false);
      }
    },
  };
}

/**
 * 模型切换权限纯决策（设计 §5.2 保守拒绝）。独立导出便于单元测试：
 * 给定预选配置与引擎标识候选行，返回拒绝原因（null=放行）。
 *
 * 规则：
 * - modelIds 非空：候选行（按引擎标识反查）任一命中预选 UUID → 放行；
 * - modelIds=[]（单模型 agent）：仅当 modelId 命中默认模型行 → 放行；
 * - 候选行为空（引擎标识不存在 / 默认模型已删除）→ INVALID_STATE（Unknown model）。
 */
export function evaluateModelSwitchPermission(
  preset: { modelIds: string[] | null; modelId: string | null },
  candidates: Array<{ id: string; modelId: string }>,
  modelId: string,
): { code: ActionErrorCode; message: string } | null {
  if (!preset.modelIds || preset.modelIds.length === 0) {
    const defaultRow = candidates.find((row) => row.id === preset.modelId);
    if (defaultRow && defaultRow.modelId === modelId) return null;
    return {
      code: "FORBIDDEN",
      message: `Model '${modelId}' is not available: this agent is locked to a single model`,
    };
  }
  if (candidates.length === 0) {
    return { code: "INVALID_STATE", message: "Unknown model" };
  }
  const allowed = new Set(preset.modelIds);
  if (candidates.some((row) => allowed.has(row.id))) return null;
  return { code: "FORBIDDEN", message: `Model '${modelId}' is not in the preset model list` };
}

/**
 * 解析 agent_config 预选模型为会话级 modelState（设计 §5.1）。
 *
 * 规则：
 * - modelIds===null（未配置）→ 返回 null（保持引擎自报，存量 agent 零影响）；
 * - modelIds===[] → 单模型 agent：仅默认模型（currentModelId=默认模型引擎标识）；
 * - 非空列表 → 按 modelIds 顺序解析（value=model.modelId，name=displayName ?? modelId）；
 *   默认模型（agentConfig.modelId）不在列表 → 过滤 + 告警（设计 §6 纵深防御）；
 *   被删除的模型引用 → 过滤 + 告警，不阻塞。
 */
async function resolvePresetModelState(
  agentId: string,
): Promise<{ currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } | null> {
  // 与 validateSetSessionModel 同一注入源（deps.environmentRepo），测试注入 fake 时行为一致
  const env = await deps.environmentRepo.getById(agentId);
  if (!env?.agentConfigId) return null;
  const preset = await getAgentModelPreset(env.agentConfigId);
  if (!preset || preset.modelIds === null) return null;

  const toEntry = (row: { modelId: string; displayName: string | null }) => ({
    modelId: row.modelId,
    name: row.displayName ?? row.modelId,
  });

  if (preset.modelIds.length === 0) {
    // 单模型 agent：仅默认模型；默认模型缺失/已删 → 告警并回退引擎自报（无可用预选）
    if (!preset.modelId) {
      logError(`[chat-bootstrap] preset model list is empty and no default model for agentConfig env '${agentId}'`);
      return null;
    }
    const defaultRows = await getModelPresetRowsByIds([preset.modelId]);
    const defaultRow = defaultRows[0];
    if (!defaultRow) {
      logError(`[chat-bootstrap] default model '${preset.modelId}' no longer exists for env '${agentId}'`);
      return null;
    }
    return { currentModelId: defaultRow.modelId, availableModels: [toEntry(defaultRow)] };
  }

  // 非空预选列表：按 modelIds 顺序解析，过滤失效项（模型被删）并告警
  const rows = await getModelPresetRowsByIds(preset.modelIds);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const availableModels: Array<{ modelId: string; name: string }> = [];
  for (const id of preset.modelIds) {
    const row = rowById.get(id);
    if (!row) {
      logError(`[chat-bootstrap] preset model '${id}' no longer exists for env '${agentId}', filtering out`);
      continue;
    }
    availableModels.push(toEntry(row));
  }
  if (availableModels.length === 0) {
    logError(
      `[chat-bootstrap] all preset models are gone for env '${agentId}', falling back to engine reported models`,
    );
    return null;
  }

  // currentModelId=默认模型；默认不在列表（数据矛盾）→ 取列表第一项 + 告警（设计 §6）
  let currentModelId = availableModels[0].modelId;
  if (preset.modelId) {
    const defaultRow = rowById.get(preset.modelId);
    if (defaultRow && availableModels.some((m) => m.modelId === defaultRow.modelId)) {
      currentModelId = defaultRow.modelId;
    } else {
      logError(
        `[chat-bootstrap] default model '${preset.modelId}' not in preset list for env '${agentId}', falling back to first preset`,
      );
    }
  }
  return { currentModelId, availableModels };
}

let controller: ChatChannelController | null = null;

/** 获取 Chat 域控制器单例（YJS WS 入口与连接注册表的统一访问点）。 */
export function getChatChannelController(): ChatChannelController {
  if (!controller) {
    controller = new ChatChannelController(buildChatChannelDependencies());
  }
  return controller;
}

/** 重置控制器单例缓存（仅用于测试；测试注入依赖后必须重置才能生效）。 */
export function resetChatChannelBootstrap(): void {
  controller = null;
}
