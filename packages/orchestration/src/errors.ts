/**
 * 编排域分层异常体系。
 *
 * 所有编排域错误统一继承 {@link OrchestrationError}，通过 `code` 字段对外提供稳定的
 * 机器可读错误码，便于上层（API 层 / 日志 / 前端）做分类处理，而不依赖 message 文本。
 * message 仅承载人类可读的诊断上下文，不得包含密钥等敏感信息。
 */

/** 编排域错误基类：所有编排异常的唯一入口。 */
export class OrchestrationError extends Error {
  /** 稳定的机器可读错误码（UPPER_SNAKE_CASE）。 */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Agent 节点不可用（未连接或已被销毁），无法承载实例。 */
export class AgentNodeUnavailableError extends OrchestrationError {
  constructor(message = "Agent node is unavailable") {
    super(message, "AGENT_NODE_UNAVAILABLE");
  }
}

/** 同一 machine 已存在在线控制信道，重复连接不能接管或替换原信道。 */
export class AgentNodeConnectionConflictError extends OrchestrationError {
  constructor(message = "Agent node already has an active connection") {
    super(message, "AGENT_NODE_CONNECTION_CONFLICT");
  }
}

/** 状态机非法转换：当前状态下不支持该事件（如 connected 时再次 connect）。 */
export class IllegalStateTransitionError extends OrchestrationError {
  constructor(message = "Illegal state transition") {
    super(message, "ILLEGAL_STATE_TRANSITION");
  }
}

/** 目标机器已配置但处于离线状态，无法建立连接。 */
export class MachineOfflineError extends OrchestrationError {
  constructor(message = "Target machine is offline") {
    super(message, "MACHINE_OFFLINE");
  }
}

/** LaunchSpec 构建失败：缺少必要配置字段或数据引用无效。 */
export class LaunchSpecBuildError extends OrchestrationError {
  constructor(message = "Failed to build launch spec") {
    super(message, "LAUNCH_SPEC_BUILD_FAILED");
  }
}

/** 指定的环境不存在或当前上下文不可见。 */
export class EnvironmentNotFoundError extends OrchestrationError {
  constructor(message = "Environment not found") {
    super(message, "ENVIRONMENT_NOT_FOUND");
  }
}
