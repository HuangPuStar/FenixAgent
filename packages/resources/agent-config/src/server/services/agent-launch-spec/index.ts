/**
 * 启动参数组装（LaunchSpec）的服务端公开入口。
 *
 * 消费者是宿主装配层：`apps/server` 在 `runCriticalStartupSequence` 之后用
 * {@link createAgentLaunchSpecAssembler} 构造组装器，并绑定到 `agent-runtime` 的
 * `AgentLaunchSpecPort`。`agent-runtime` 自身不再直接依赖组装实现（review §15.3）。
 *
 * 组装依赖全部经 {@link AgentLaunchSpecAssemblerDeps} 注入：本模块不读 `process.env`、不读宿主
 * config、不访问数据库；`deps` 里的资源能力一律走各资源包的包根 Domain Service。
 */
export { buildAgentLaunchSpec, buildMinimalLaunchSpec, createAgentLaunchSpecAssembler } from "./assembler";
export type {
  AgentLaunchSpecAssembler,
  AgentLaunchSpecAssemblerDeps,
  AgentLaunchSpecEnv,
  BuildAgentLaunchSpecInput,
  BuildMinimalLaunchSpecInput,
  RuntimeCredentialInput,
  RuntimeCredentialResolver,
  RuntimeCredentialResult,
} from "./types";
