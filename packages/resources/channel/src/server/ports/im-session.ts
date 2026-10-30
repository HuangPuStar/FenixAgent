/**
 * IM 会话桥的 Agent 运行时端口（规格 §6.1 第 5-6 步）。
 *
 * 为什么是端口：专属实例、ACP 会话与 prompt 属于 Agent 运行时的数据面，channel 包不拥有它们；
 * 业务层只按这里的四个动作描述冷启动，适配器负责把运行时能力接上来，包内不复制 ACP 协议。
 *
 * `runtimeToken` 是暖态作废的唯一运行时信号：实例记录重启后 uid 不变，只有运行代次变化；漏掉它
 * 会让重启后的首条消息仍走订阅通知，而 inbox 尚未注册，消息静默丢失。
 */

/** 一次 IM 消息要投递到的聊天；`conversationId` 是暖态、token 与 MCP 连接的作用域。 */
export interface ImSessionTarget {
  readonly channelId: string;
  readonly conversationId: string;
  readonly organizationId: string;
  /** 通道所有者，也是 Agent 的执行身份。 */
  readonly ownerUserId: string;
  readonly agentConfigId: string;
  /** 该聊天的确定性 Chat 会话键，用于 relay / Y.Doc 隔离。 */
  readonly rcsSessionId: string;
  /** 已有 ACP 会话时恢复，否则新建。 */
  readonly acpSessionId: string | null;
}

/** 确保专属实例所需的聊天身份；不传 ACP 会话，实例与 ACP 会话无关。 */
export interface ImSessionInstanceInput {
  readonly conversationId: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly agentConfigId: string;
}

/** 已就绪的专属实例。 */
export interface ImSessionInstanceRef {
  readonly instanceId: string;
  /** 运行代次或等价标识；实例重启后必须变化。 */
  readonly runtimeToken: string;
}

/** 打开（或恢复）会话所需的最小输入。 */
export interface ImSessionOpenPortInput {
  readonly target: ImSessionTarget;
  readonly instance: ImSessionInstanceRef;
}

/** 平台侧持有的会话句柄；只用于本次投递，不拥有持久实例生命周期。 */
export interface ImSessionHandle {
  /**
   * 本次投递的句柄标识，由端口实现生成。
   *
   * 不能用 `conversationId` 定位：同一聊天换 Agent 后 rcsSessionId 变化，并发冷启动会各自打开一个
   * 会话，按聊天键查找会让后者的 prompt/close 落到前者的 turn 上。
   */
  readonly handleId: string;
  readonly conversationId: string;
  readonly instanceId: string;
  /** `session/new` 或 `session/load` 确认后的 ACP 会话 ID。 */
  readonly acpSessionId: string;
}

/** 通用唤醒的发送输入；正文由桥接层固定，端口不得改写或补充业务数据。 */
export interface ImWakePromptInput {
  readonly session: ImSessionHandle;
  readonly text: string;
}

/**
 * Agent 运行时端口。
 *
 * `sendWakePrompt` 在 Agent 接受 `session/prompt` 后返回，不等待整轮执行结束；失败必须以错误上抛，
 * 不得返回成功。`close` 只释放本次投递的会话与 relay 消费租约，不停止持久实例。
 */
export interface ImSessionPort {
  ensureInstance(input: ImSessionInstanceInput): Promise<ImSessionInstanceRef>;
  openSession(input: ImSessionOpenPortInput): Promise<ImSessionHandle>;
  sendWakePrompt(input: ImWakePromptInput): Promise<void>;
  close(session: ImSessionHandle): Promise<void>;
}

let boundPort: ImSessionPort | null = null;

/**
 * 由宿主装配阶段绑定实现；与 Agent 配置端口同一模式。
 *
 * 模块可能在宿主绑定之前构造（registry 工厂先于启动流程），因此消费方必须在调用时取值，不能缓存构造期结果。
 */
export function bindImSessionPort(port: ImSessionPort): void {
  if (boundPort && boundPort !== port) throw new Error("ImSessionPort has already been bound");
  boundPort = port;
}

/** 取端口；未装配即报错，不做兜底实现——静默降级会让入站消息无人消费。 */
export function getImSessionPort(): ImSessionPort {
  if (!boundPort) throw new Error("ImSessionPort has not been bound");
  return boundPort;
}

/** 测试用：清空绑定，避免跨用例共享状态。 */
export function resetImSessionPort(): void {
  boundPort = null;
}
