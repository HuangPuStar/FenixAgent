#!/usr/bin/env node
/**
 * dsh (DeepSeek Harness) 伪装为 ccb 槽位的启动 wrapper。
 *
 * 背景：acp-runtime 的 ccb handler（packages/plugin-ccb）在 prepareWorkspace 阶段
 * 把 AgentLaunchSpec 的模型信息写成 `<workspace>/.claude/settings.local.json`
 * （env.ANTHROPIC_MODEL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL 等），
 * 并在 startInstance 阶段以 RCS_CCB_COMMAND/RCS_CCB_ARGS 指定的命令启动引擎。
 *
 * 本脚本作为 RCS_CCB_COMMAND 的执行体：
 *   1. 读取当前 cwd（= 实例 workspace）下的 ccb settings，提取模型配置；
 *   2. 生成 dsh 的 cordis.yml（llm-pi-ai 自定义 route + acp-agent）；
 *   3. API key 经 DSH_LLM_API_KEY 环境变量传给 dsh 进程，不落盘；
 *   4. 以 stdio inherit 启动 dsh-acp-demo 并转发 SIGTERM/SIGINT，
 *      保证 acp-link 的进程管理（kill → 容器内优雅退出）语义不变。
 *
 * 受限说明（dsh automation-only ACP）：
 *   - session/new 不接受非空 mcpServers / additionalDirectories，平台若下发
 *     MCP 配置会导致 invalidParams（见 README「已知限制」）；
 *   - 输出为已提交整块文本（agent_message_chunk），非 token 级流式。
 */

const { spawn } = require("node:child_process");
const { readFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** cordis.yml 中 API key 引用的环境变量名（wrapper 以同名 env 传给 dsh 进程）。 */
const DSH_LLM_API_KEY_ENV = "DSH_LLM_API_KEY";
const CORDIS_CONFIG_NAME = "cordis.yml";
const CCB_SETTINGS_REL = join(".claude", "settings.local.json");

const DEFAULT_PERSONA = `You are a helpful coding assistant powered by the {{model}} model. Your working directory is {{cwd}}.
Verify your work by running the code or tests. Keep answers brief and factual.`;

/** provider 名 → pi-ai route key 安全化；无合法字符时回退固定名。 */
function slugifyProviderRoute(provider) {
  const slug = String(provider)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "llm-route";
}

/** YAML 双引号字符串，防注入值内的引号/换行破坏 composition。 */
function yamlString(value) {
  return JSON.stringify(String(value));
}

/** baseUrl 为空时按协议回退官方默认端点。 */
function resolveBaseUrl(baseUrl, protocol) {
  if (baseUrl && baseUrl.length > 0) return baseUrl;
  return protocol === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com";
}

/**
 * 读取 ccb handler 写入的 settings.local.json。
 * 文件缺失或无法解析时返回 null（调用方走失败路径，不静默降级）。
 */
function loadCcbSettings(cwd) {
  const path = join(cwd, CCB_SETTINGS_REL);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[dsh-wrapper] 解析 ${path} 失败: ${err.message}`);
    return null;
  }
}

/** 从 ccb settings 提取 dsh 需要的模型三元组。 */
function extractModel(settings) {
  const env = settings && typeof settings.env === "object" ? settings.env : {};
  const protocol =
    settings.modelType === "openai" || settings.modelType === "anthropic"
      ? settings.modelType
      : env.CLAUDE_CODE_USE_OPENAI === "1"
        ? "openai"
        : "anthropic";
  const model = settings.model || env.ANTHROPIC_MODEL || env.OPENAI_MODEL || "";
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || "";
  const baseUrl = protocol === "openai" ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL;
  const provider = "ccb-bridge";
  return { protocol, model, apiKey, baseUrl, provider };
}

/**
 * 生成 dsh ACP composition（cordis.yml）。
 * 以官方 examples/acp-agent/cordis.yml 为蓝本裁剪：仅保留容器内可跑的最小组合，
 * 去掉 subagent/workflow/hooks 等可选插件；sandbox 限域 workspace，approval 固定
 * never 不打断自动化；持久化关闭压缩（容器内无 zstd 运行库）。
 */
function buildCordisConfig({ provider, protocol, model, baseUrl, persona }) {
  const route = slugifyProviderRoute(provider);
  const api = protocol === "openai" ? "openai-completions" : "anthropic";
  const resolvedBaseUrl = resolveBaseUrl(baseUrl, protocol);
  const personaText = persona && persona.trim().length > 0 ? persona : DEFAULT_PERSONA;

  const lines = [
    "# 由 dsh-acp-wrapper 生成，勿手改。",
    `# provider=${yamlString(provider)} protocol=${protocol} model=${yamlString(model)}`,
    "",
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    "  config:",
    "    providers:",
    `      ${route}:`,
    `        displayName: ${yamlString(provider)}`,
    `        apiKeyEnv: ${DSH_LLM_API_KEY_ENV}`,
    `        api: ${yamlString(api)}`,
    `        baseURL: ${yamlString(resolvedBaseUrl)}`,
    "        models:",
    `          - id: ${yamlString(model)}`,
    "",
    "- id: sandbox",
    "  name: '@deepseek-ai/dsh-sandbox-local'",
    "- id: sandbox-policy",
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    "  config:",
    "    mode: workspace-write",
    "    workspaceRoot: !!js process.cwd()",
    "- id: subprocess",
    "  name: '@deepseek-ai/dsh-subprocess-local'",
    "- id: bash",
    "  name: '@deepseek-ai/dsh-bash-sandbox'",
    "  config:",
    "    timeoutMs: 60000",
    "",
    "- id: approval",
    "  name: '@deepseek-ai/dsh-user-approval'",
    "  config:",
    "    policy: never",
    "",
    "- id: acp-agent",
    "  name: '@deepseek-ai/dsh-acp-demo'",
    "  config:",
    `    provider: ${route}`,
    `    model: ${yamlString(model)}`,
    "    persistenceRoot: './.sessions'",
    "    persistenceCompression: none",
    "    workspaceContext:",
    "      maxBytes: 65536",
    "    persona: |",
    ...personaText.split("\n").map((line) => `      ${line}`),
    "",
    "- id: token-meter",
    "  name: '@deepseek-ai/dsh-token-meter'",
    "- id: compaction-basic",
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    "  config:",
    "    thresholdRatio: 0.8",
    "    retainRatio: 0.08",
    "    maxTokens: 8192",
    "    compactionRetries: 1",
    "",
    "- id: fs-sandbox",
    "  name: '@deepseek-ai/dsh-fs-sandbox'",
    "  config:",
    "    cwd: !!js process.cwd()",
    "- id: fs-observation-policy",
    "  name: '@deepseek-ai/dsh-fs-observation-policy'",
    "- id: tool-fs",
    "  name: '@deepseek-ai/dsh-tool-fs'",
    "",
  ];
  return lines.join("\n");
}

function fail(message) {
  console.error(`[dsh-wrapper] ${message}`);
  process.exit(1);
}

function main() {
  const cwd = process.cwd();

  const settings = loadCcbSettings(cwd);
  if (!settings) {
    fail(`未找到 ${CCB_SETTINGS_REL}（ccb handler 尚未 prepare workspace）`);
  }

  const modelInfo = extractModel(settings);
  if (!modelInfo.model) {
    fail("settings.local.json 缺少模型配置（model / ANTHROPIC_MODEL / OPENAI_MODEL 均为空）");
  }

  // persona：优先 workspace 根目录的 CLAUDE.md（ccb handler 写入的 agent prompt）
  let persona = null;
  const claudeMdPath = join(cwd, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    persona = readFileSync(claudeMdPath, "utf8");
  }

  const cordis = buildCordisConfig({ ...modelInfo, persona });
  const cordisPath = join(cwd, CORDIS_CONFIG_NAME);
  writeFileSync(cordisPath, cordis, "utf8");
  console.log(`[dsh-wrapper] 已生成 ${cordisPath}（model=${modelInfo.model} protocol=${modelInfo.protocol}）`);

  // API key 只进子进程环境，不落盘、不进日志
  const child = spawn("dsh-acp-demo", ["--config", cordisPath], {
    stdio: "inherit",
    env: { ...process.env, [DSH_LLM_API_KEY_ENV]: modelInfo.apiKey },
  });

  // 转发终止信号：acp-link kill(SIGTERM) → wrapper → dsh → 优雅退出
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
}

main();
