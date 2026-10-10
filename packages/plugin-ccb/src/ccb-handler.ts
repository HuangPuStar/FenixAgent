import {
  buildCcbMcpConfig,
  buildCcbRuntimeConfig,
  installSkills as installCcbSkills,
  writeCcbConfig,
} from "@fenix/ccb";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { AcpDispatcher } from "acp-link/acp-dispatcher";
import { spawnAcpAgent } from "acp-link/client/acp-spawn-helper";
import type { EngineHandler, EngineStartContext } from "acp-link/client/instance-manager";
import { resolveExecutable } from "acp-link/client/resolve-executable";
import { prepareLaunchWorkspace } from "./runtime/environment-preparer";

export interface CcbHandlerOptions {
  /**
   * skill 归档下载的 origin（agent 侧能访问到主服务的基址，可给 `ws(s)://`）。
   *
   * 与引擎命令同属 daemon / 容器侧部署配置，取值来自 `acp-runtime-cli` 读入后经 `ServerConfig` 下发的
   * `rcsUrl`。未注入时 installer 保持 launchSpec 里的原始 URL（宿主自身生成的地址本就可达）。
   */
  downloadOrigin?: string;
}

/**
 * ccb 引擎 handler：spawn ccb --acp 子进程，通过 ACP stdio 通信。
 *
 * 引擎命令走构造参数注入（与 opencode / peri handler 同形），handler 不直读 `process.env`：daemon / 容器侧的
 * ccb 引擎命令与参数、skill 下载 origin 都是部署配置（compose 里声明），由 `acp-runtime-cli` 读取后经
 * `ServerConfig` 传入——宿主 env schema 不声明这些键，宿主进程内也零消费者。
 */
export function createCcbHandler(
  binary?: string,
  extraArgs?: string[],
  options: CcbHandlerOptions = {},
): EngineHandler {
  // 延迟到 startInstance 才 resolve executable，避免机器上没有 ccb 二进制时启动失败
  const binaryName = binary ?? "ccb";
  const args = extraArgs ?? ["--acp"];

  return {
    async prepareWorkspace(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
      launchSpec = await prepareLaunchWorkspace(workspace, launchSpec);
      const installedSkills = await installCcbSkills(workspace, launchSpec.skills, {
        downloadOrigin: options.downloadOrigin,
      });
      const runtimeConfig = buildCcbRuntimeConfig(launchSpec, installedSkills);
      await writeCcbConfig(workspace, runtimeConfig);

      const mcpConfig = buildCcbMcpConfig(launchSpec);
      // .mcp.json 每次 prepare 全量重写：空集合必须落盘成 `{"mcpServers":{}}`，
      // 否则取消全部 MCP 后旧文件残留，agent 继续加载已取消的 server。
      const { writeCcbMcpConfig } = await import("@fenix/ccb");
      await writeCcbMcpConfig(workspace, mcpConfig);
      console.log(`[ccb-handler] wrote .mcp.json with ${Object.keys(mcpConfig.mcpServers).length} servers`);

      if (launchSpec.agent.prompt) {
        const { writeClaudeMd } = await import("@fenix/ccb");
        await writeClaudeMd(workspace, launchSpec.agent.prompt);
        console.log("[ccb-handler] wrote CLAUDE.md");
      }
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
        console.log(`[ccb-handler] ccb exited: ${instanceId}, code=${code}`);
        state.process = null;
        state.connection = null;
      });

      // ccb 的 ACP 只支持单会话（newSession 永远返回同一个 sessionId）
      // 不伪装多会话能力，让前端按单会话模式工作
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

      console.log(`[ccb-handler] started: ${instanceId}`);
      return { capabilities };
    },
  };
}
