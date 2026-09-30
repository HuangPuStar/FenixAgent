import { error as logError } from "@fenix/logger";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import {
  getHindsightConfig,
  HINDSIGHT_PLUGIN_DEFAULTS,
  isAgentMemoryEnabled,
  resolveMemberId,
} from "@fenix/resource-memory/server";
import { LAUNCH_SPEC_LOG_PREFIX } from "./support";
import type { AgentLaunchSpecAssemblerDeps } from "./types";

/** 仅用于清除旧 extra 配置面；npm/市场名称的启用映射由各引擎负责。 */
const HINDSIGHT_PLUGIN_NAME = "@konghayao/opencode-hindsight";

export interface MemoryLaunchEnv {
  readonly extra: Record<string, unknown> | null;
  readonly plugins: NonNullable<AgentLaunchSpec["plugins"]>;
  readonly workspaceFiles: NonNullable<AgentLaunchSpec["workspaceFiles"]>;
}

/**
 * 将记忆领域配置转换为可传输的工作区文件 DTO。配置键对齐插件 src/lib/config.ts 的 DEFAULTS，
 * 不再把配置值放进 env 或 opencode 插件参数；银行隔离无法解析时关闭记忆，不回落到共享 bank。
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
  const configuredPlugins = input.extra?.plugin;
  const extra = Array.isArray(configuredPlugins)
    ? {
        ...input.extra,
        plugin: configuredPlugins.filter((entry) =>
          typeof entry === "string"
            ? entry !== HINDSIGHT_PLUGIN_NAME
            : Array.isArray(entry) && typeof entry[0] === "string" && entry[0] !== HINDSIGHT_PLUGIN_NAME,
        ),
      }
    : input.extra;
  const disabled: MemoryLaunchEnv = { extra, plugins: [], workspaceFiles: [] };
  const hindsight = getHindsightConfig();
  if (!hindsight || !(await isAgentMemoryEnabled(input.agentConfigId))) return disabled;

  let bankId: string | null;
  try {
    bankId = await resolveMemberId({ organizationId: input.organizationId, userId: input.userId });
    if (!bankId) throw new Error("Hindsight 成员不存在");
  } catch {
    logError(`${LAUNCH_SPEC_LOG_PREFIX} Hindsight 成员解析失败，已关闭本次记忆以避免共享 bank`);
    return disabled;
  }

  return {
    extra,
    plugins: ["hindsight"],
    workspaceFiles: [
      {
        path: ".hindsight/workspace.json",
        envVar: "HINDSIGHT_CONFIG",
        content: {
          ...HINDSIGHT_PLUGIN_DEFAULTS,
          hindsightApiUrl: hindsight.url,
          // null 在插件侧表示「未设置」而不是「清空」：插件 config.ts:291-292 跳过 null 值，因此这里
          // 表达的是「平台未提供 token」，机器侧 env / 用户配置里的 token 仍会生效——与改造前一致
          // （改造前也只有平台配置了 token 时才注入 HINDSIGHT_API_TOKEN）。
          hindsightApiToken: deps.env.hindsightApiToken || null,
          llmProvider: "claude-code",
          bankId,
          // ── 隔离钉：以下键共同决定「记忆写到哪个 bank / 从哪些 bank 读」，是隔离契约的一部分，不得删除 ──
          // 托管文件虽是插件配置的最高层，但插件按**逐键**覆盖合并（插件 config.ts:287-295），
          // 未在此写出的键会从低优先级层取值：插件 settings.json、~/.hindsight/<engine>.json、HINDSIGHT_* env。
          // 而插件 bank.ts:135-164 的解析顺序是 directoryBankMap → bankIdPrefix → 静态 bankId → 动态组合，
          // 即 directoryBankMap / bankIdPrefix 优先于 bankId：不把它们钉成空值，用户级配置就能把成员 bank
          // 改写成任意 bank（如 USERPREFIX-member-org-a-1），托管文件里的 bankId 形同虚设。
          // 同理 recallAdditionalBanks / recallAdditionalBankFilters 未钉死时，插件会用**平台 client
          // （含平台 token）**对任意 bank 发起 recall（插件 hooks/recall.ts:381-407），把读取面也带出成员隔离。
          // 空值语义：bankIdPrefix "" 与 directoryBankMap {} 让解析直接落到静态 bankId；
          // 两个空容器让跨 bank 召回循环不进入。改这些空值时必须同步核对插件对应读取分支。
          bankIdPrefix: "",
          directoryBankMap: {},
          recallAdditionalBanks: [],
          recallAdditionalBankFilters: {},
          // 静态模式：不允许按目录/会话组合 bank；dynamicBankGranularity 因此无需钉（静态分支不会读它）。
          dynamicBankId: false,
        },
      },
    ],
  };
}

/** 观测变量仍独立下发；密钥仅经受信 relay 传输，不入日志。 */
export function buildLangfuseEnv(deps: AgentLaunchSpecAssemblerDeps): Record<string, string> {
  const configured = deps.env.langfuse;
  const env: Record<string, string> = {};
  if (configured?.publicKey) env.LANGFUSE_PUBLIC_KEY = configured.publicKey;
  if (configured?.secretKey) env.LANGFUSE_SECRET_KEY = configured.secretKey;
  if (configured?.baseUrl) env.LANGFUSE_BASE_URL = configured.baseUrl;
  return env;
}
