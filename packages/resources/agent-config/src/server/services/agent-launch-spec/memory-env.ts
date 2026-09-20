import { error as logError } from "@fenix/logger";
import {
  getHindsightConfig,
  HINDSIGHT_PLUGIN_DEFAULTS,
  isAgentMemoryEnabled,
  resolveMemberId,
} from "@fenix/resource-memory/server";
import { LAUNCH_SPEC_LOG_PREFIX } from "./support";
import type { AgentLaunchSpecAssemblerDeps } from "./types";

/**
 * 记忆与观测的运行期环境：把「Agent 是否启用记忆」「宿主是否配置了 Hindsight / Langfuse」翻译成
 * agent 进程能直接读到的两个投递面。
 *
 * 两条投递面是并存的，不能只做一条：
 * - **opencode 引擎**读 `agent.extra.plugin`（记忆插件由运行时动态构造，旧条目必须被替换掉）
 * - **ccb 引擎**读 `launchSpec.env` 里的 `HINDSIGHT_*` 变量
 *
 * 记忆开关的两级判定（系统级基础设施可用 / Agent 级用户开关）是记忆包的领域规则，这里直接复用它的
 * 两个入口，而不是内联判条件——否则"什么算启用"就会在启动路径上出现第二份定义。
 */

/** Hindsight 插件名：open/ccb 两条路径共用，也是「过滤旧条目」时要比对的键。 */
const HINDSIGHT_PLUGIN_NAME = "@konghayao/opencode-hindsight";

/** 记忆注入的结果：`extra` 回写 `agent.extra`，`env` 并入 `launchSpec.env`。 */
export interface MemoryLaunchEnv {
  readonly extra: Record<string, unknown> | null;
  readonly env: Record<string, string>;
}

/**
 * 构造记忆相关的 extra / env；未启用时原样返回传入的 `extra`，不产生副作用。
 *
 * `bankId` 解析失败只记日志、不阻断启动：它是 Hindsight 侧的隔离标识，缺失时记忆退化为"不区分 bank"
 * 而不是让 Agent 起不来（与迁移前的行为一致）。日志与错误消息里都不出现 `HINDSIGHT_API_TOKEN`。
 */
export async function buildMemoryLaunchEnv(
  deps: AgentLaunchSpecAssemblerDeps,
  input: {
    agentConfigId: string;
    organizationId: string;
    userId: string;
    extra: Record<string, unknown> | null;
  },
): Promise<MemoryLaunchEnv> {
  const hindsight = getHindsightConfig();
  if (!hindsight) return { extra: input.extra, env: {} };
  if (!(await isAgentMemoryEnabled(input.agentConfigId))) return { extra: input.extra, env: {} };

  let bankId: string | null = null;
  try {
    // bankId 是既有外部约定（Hindsight bank 标识），成员关系读取经 IdentityDirectory（由记忆包封装）。
    bankId = await resolveMemberId({ organizationId: input.organizationId, userId: input.userId });
  } catch (error) {
    logError(`${LAUNCH_SPEC_LOG_PREFIX} failed to resolve memberId for Hindsight bankId: ${String(error)}`, error);
  }

  // opencode 路径：用动态构造的插件条目替换 `extra.plugin` 里可能存在的旧条目（用户可手改 extra，
  // 不替换就会出现两份同名的记忆插件，行为取决于插件加载顺序）。
  // 校验形状而不是整体强转：`extra.plugin` 是用户可写的 JSON，非数组、或首项不是插件名的条目对
  // opencode 没有意义，丢弃比原样透传更可预测（迁移前的实现用双强制转换原样透传）。校验到此为止：
  // 其余条目按原样保留——它们由用户自己负责，本函数只负责替换记忆插件那一条。
  const configuredPlugins: unknown = input.extra?.plugin;
  const existingPlugins = (Array.isArray(configuredPlugins) ? configuredPlugins : []).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      Array.isArray(entry) && typeof entry[0] === "string" && entry[0] !== HINDSIGHT_PLUGIN_NAME,
  );
  existingPlugins.push([
    HINDSIGHT_PLUGIN_NAME,
    {
      ...HINDSIGHT_PLUGIN_DEFAULTS,
      hindsightApiUrl: hindsight.url,
      ...(bankId ? { bankId } : {}),
    },
  ]);

  // ccb 路径：同址的 `HINDSIGHT_*` 变量；apiToken 只在宿主配置了才注入。
  const env: Record<string, string> = {
    HINDSIGHT_API_URL: hindsight.url,
    HINDSIGHT_LLM_PROVIDER: "claude-code",
    ...(bankId ? { HINDSIGHT_BANK_ID: bankId } : {}),
  };
  if (deps.env.hindsightApiToken) env.HINDSIGHT_API_TOKEN = deps.env.hindsightApiToken;

  return { extra: { ...(input.extra ?? {}), plugin: existingPlugins }, env };
}

/**
 * 构造透传给 machine 上 agent 进程的 Langfuse 环境变量。
 *
 * 只透传声明的三个键，避免无关 `LANGFUSE_*` 泄漏；额外变量（含 `LANGFUSE_USER_ID` 这类按实例注入的
 * 维度）由调用方经 `extraEnv` 传入，同名变量优先。SECRET_KEY 是密钥，仅随受信 relay 通道传输。
 */
export function buildLangfuseEnv(deps: AgentLaunchSpecAssemblerDeps): Record<string, string> {
  const configured = deps.env.langfuse;
  const env: Record<string, string> = {};
  if (configured?.publicKey) env.LANGFUSE_PUBLIC_KEY = configured.publicKey;
  if (configured?.secretKey) env.LANGFUSE_SECRET_KEY = configured.secretKey;
  if (configured?.baseUrl) env.LANGFUSE_BASE_URL = configured.baseUrl;
  return env;
}
