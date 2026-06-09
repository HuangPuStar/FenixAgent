import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

/** bridge 模块的启动选项 */
export interface BridgeStartOptions {
  /** workspace 绝对路径 */
  cwd: string;
  /** 环境变量覆盖 */
  env?: Record<string, string>;
  /** 系统提示词（从 session_start.agent_prompt 传入） */
  systemPrompt?: string;
  /** 引擎特定配置（从 session_start.engine_config 传入） */
  engineConfig?: Record<string, unknown>;
}

/**
 * acp-link 进程内的 bridge 模块接口。
 * 每个 engine 类型实现此接口，封装该引擎特有的环境准备、子进程 spawn、
 * ACP 协议使用方式和消息路由。acp-link 根据 engine_type 选择对应 bridge 模块。
 */
export interface BridgeModule {
  /** 环境准备：创建配置目录、写入配置文件、安装 skills */
  prepare(workspace: string, launchSpec: AgentLaunchSpec): Promise<void>;

  /** spawn 子进程 + 建立通信，返回 capabilities */
  start(sessionId: string, options: BridgeStartOptions): Promise<{ capabilities: Record<string, unknown> }>;

  /** 发送 ACP 消息到子进程 */
  sendData(sessionId: string, acpMessage: unknown): Promise<boolean>;

  /** 终止子进程 */
  stop(sessionId: string): Promise<void>;

  /** 事件监听（子进程输出 → ACP 事件） */
  on(event: string, callback: (sessionId: string, payload: unknown) => void): void;
}
