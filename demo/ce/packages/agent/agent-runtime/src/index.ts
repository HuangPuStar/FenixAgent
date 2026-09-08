/** 原样复用的 Agent 运行时包契约；不同引擎在 CE 内部作为静态适配器选择。 */
export interface AgentRuntimeModule {
  readonly engine: string;
  run(input: { agentId: string; prompt: string }): Promise<{ engine: string; text: string }>;
}

/** EE 直接从 CE submodule 导入此实例，不复制 Agent 编排、ACP 或 Chat 主链路。 */
export const sharedAgentRuntime: AgentRuntimeModule = {
  engine: "opencode",
  async run({ agentId, prompt }) {
    return { engine: "opencode", text: `${agentId}: ${prompt}` };
  },
};
