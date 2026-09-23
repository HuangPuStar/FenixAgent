import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { AcpDispatcher } from "acp-link/acp-dispatcher";
import { spawnAcpAgent } from "acp-link/client/acp-spawn-helper";
import type { EngineHandler, EngineStartContext } from "acp-link/client/instance-manager";
import { resolveExecutable } from "acp-link/client/resolve-executable";
import { prepareWorkspaceEnvironment, writePeriSettings } from "./runtime/environment-preparer";
import { buildPeriMcpConfig, buildPeriRuntimeConfig } from "./runtime/runtime-config";
import { installSkills } from "./runtime/skill-installer";

/**
 * peri 引擎 handler：spawn peri acp 子进程，通过 ACP stdio 通信。
 *
 * 用于远程 machine 侧（acp-link client 模式）：机器上已装好 peri，
 * 由 `acp-runtime peri acp` 传入命令与参数。
 *
 * 与 `@fenix/ccb` 的 handler 的差异：peri 是独立引擎，workspace 物化时**无条件**写
 * `.peri/settings.json`；ccb 侧只在 `IS_PERI=1` 时写（沙箱用 ccb 槽位伪装 peri 的历史路径）。
 */
export function createPeriHandler(binary?: string, extraArgs?: string[]): EngineHandler {
  // 延迟到 startInstance 才 resolve executable，避免机器上没有 peri 时启动失败
  const binaryName = binary ?? "peri";
  const args = extraArgs ?? ["acp"];

  return {
    async prepareWorkspace(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
      const installedSkills = await installSkills(workspace, launchSpec.skills);
      const runtimeConfig = buildPeriRuntimeConfig(launchSpec, installedSkills);
      const mcpConfig = buildPeriMcpConfig(launchSpec);
      await prepareWorkspaceEnvironment(workspace, runtimeConfig, mcpConfig, launchSpec.agent.prompt, installedSkills);
      await writePeriSettings(workspace, launchSpec);
      console.log(
        `[peri-handler] prepared workspace: skills=${installedSkills.length} mcpServers=${
          mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0
        }`,
      );
    },

    async startInstance(ctx: EngineStartContext) {
      const { state, instanceId, send } = ctx;

      const resolved = resolveExecutable(binaryName);

      const {
        process: proc,
        connection,
        capabilities,
        resolvePermissionOutcome,
        resolveQuestionAnswer,
      } = await spawnAcpAgent(resolved, args, state.workspace, state.launchSpec.env, send);

      // biome-ignore lint/suspicious/noExplicitAny: Bun.ChildProcess 不继承 EventEmitter，需 cast 监听 exit
      (proc as any).on("exit", (code: number | null) => {
        console.log(`[peri-handler] peri exited: ${instanceId}, code=${code}`);
        state.process = null;
        state.connection = null;
      });

      state.process = proc;
      state.connection = connection;
      state.capabilities = capabilities;
      state.sessionState.connection = connection;
      const caps = capabilities as Record<string, unknown> | null;
      state.sessionState.agentCapabilities = caps
        ? {
            _meta: (caps._meta as Record<string, unknown> | null) ?? undefined,
            loadSession: caps.loadSession as boolean | undefined,
            mcpCapabilities: caps.mcpCapabilities as Record<string, unknown> | undefined,
            promptCapabilities: caps.promptCapabilities as Record<string, unknown> | undefined,
            sessionCapabilities: caps.sessionCapabilities as Record<string, unknown> | undefined,
          }
        : null;
      state.sessionState.promptCapabilities = (caps?.promptCapabilities as Record<string, unknown> | null) ?? null;
      state.dispatcher = new AcpDispatcher(state.sessionState, {
        send,
        workspace: state.workspace,
        onPermissionOutcome: resolvePermissionOutcome,
        // elicitation 答案（前端 respond_question → control_response 帧）路由回
        // spawnAcpAgent 的 pendingQuestions，组装 content 后作为 elicitation/create 响应
        onControlResponse: (requestId, _approved, extra) => {
          resolveQuestionAnswer(requestId, extra);
        },
      });

      console.log(`[peri-handler] started: ${instanceId}`);
      return { capabilities };
    },

    async stopInstance(state) {
      if (state.process && !state.process.killed) {
        state.process.kill("SIGTERM");
      }
    },
  };
}
