#!/usr/bin/env node
/**
 * ACP Runtime 节点启动入口 — 可通过 `bun build` 打包为独立 JS 文件。
 *
 * 用法:
 *   acp-runtime <agent-command> [agent-args...]
 *
 * 必填环境变量:
 *   RCS_URL             WS base URL，如 ws://localhost:3000 或 wss://rcs.example.com
 *   RCS_SECRET          client 端鉴权 secret
 *   RCS_TENANT_ID       用于远程注册机器的组织 ID
 *
 * 可选环境变量:
 *   RCS_USER_ID         用户 ID (可选)
 *   RCS_LABELS          节点标签，逗号分隔 (默认 remote-runtime)
 *   RCS_MACHINE_NAME    机器显示名称 (可选，不传则使用 hostname)
 *   AGENT_TYPE          Agent 类型: opencode (默认) 或 ccb (Claude Code)
 *                       必须与实际启动的 agent 命令匹配，否则 RCS 无法管理生命周期
 *
 * 工作区路径: workspace 根目录为启动目录 (cwd)，实例路径自动按
 *   {cwd}/{organizationId}/{userId}/{environmentId} 计算。
 */

import { startServer } from "acp-link";

// ── 配置 ──
const RCS_URL = process.env.RCS_URL;
const RCS_SECRET = process.env.RCS_SECRET;
const TENANT_ID = process.env.RCS_TENANT_ID;
const USER_ID = process.env.RCS_USER_ID || "";
const LABELS = process.env.RCS_LABELS || "remote-runtime";
const MACHINE_NAME = process.env.RCS_MACHINE_NAME || "";
const AGENT_TYPE = (process.env.AGENT_TYPE || "opencode") as "opencode" | "ccb";
// ──────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("启动 ACP Runtime 节点 — 连接到 RCS 主服务器");
  console.log("");
  console.log("用法: acp-runtime <agent-command> [agent-args...]");
  console.log("");
  console.log("示例:");
  console.log("  RCS_URL=ws://localhost:3000 RCS_SECRET=xxx RCS_TENANT_ID=xxx acp-runtime opencode acp");
  console.log("  AGENT_TYPE=ccb RCS_URL=wss://rcs.example.com RCS_SECRET=xxx RCS_TENANT_ID=xxx \\");
  console.log("    acp-runtime npx @anthropic-ai/claude-code --acp");
  console.log("");
  console.log("必填环境变量:");
  console.log("  RCS_URL             WS base URL，如 ws://localhost:3000 或 wss://rcs.example.com");
  console.log("  RCS_SECRET          client 端鉴权 secret");
  console.log("  RCS_TENANT_ID       用于远程注册机器的组织 ID");
  console.log("");
  console.log("可选环境变量:");
  console.log("  RCS_USER_ID         用户 ID (可选)");
  console.log("  RCS_LABELS          节点标签，逗号分隔 (默认 remote-runtime)");
  console.log("  RCS_MACHINE_NAME    机器显示名称 (默认 hostname)");
  console.log("  AGENT_TYPE          Agent 类型: opencode (默认) 或 ccb (Claude Code)");
  console.log("                     必须与实际 agent 命令匹配，否则 RCS 无法管理生命周期");
  process.exit(1);
}

// ── 必填环境变量校验 ──
const missing: string[] = [];
if (!RCS_URL) missing.push("RCS_URL");
if (!RCS_SECRET) missing.push("RCS_SECRET");
if (!TENANT_ID) missing.push("RCS_TENANT_ID");
if (missing.length > 0) {
  console.error(`缺少必填环境变量: ${missing.join(", ")}`);
  console.error("");
  console.error("必填项:");
  console.error("  RCS_URL        WS base URL，如 ws://localhost:3000 或 wss://rcs.example.com");
  console.error("  RCS_SECRET     client 端鉴权 secret");
  console.error("  RCS_TENANT_ID  用于远程注册机器的组织 ID");
  process.exit(1);
}

// RCS_URL 已通过必填校验
const wsUrl = RCS_URL!;

// 健康检查：只验证服务可达，不依赖特定路径返回 2xx
const httpUrl = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
try {
  const res = await fetch(httpUrl, { redirect: "manual" });
  // 任何 HTTP 响应（含 3xx/4xx）都说明服务在线，只有网络错误才视为不可达
  if (res.status === 0) throw new Error("no response");
} catch {
  console.error(`RCS (${wsUrl}) 未响应，请先启动 RCS`);
  process.exit(1);
}

const [command, ...agentArgs] = args;

console.log(`RCS 在线 (${wsUrl})`);
console.log(`启动 ACP Runtime 节点...`);
console.log(`  Agent:        ${command} ${agentArgs.join(" ")}`);
console.log(`  Agent Type:   ${AGENT_TYPE}`);
console.log(`  Workspace:    ${process.cwd()} (cwd)`);
console.log(`  Tenant:       ${TENANT_ID}`);
console.log(`  Labels:       ${LABELS}`);
if (MACHINE_NAME) {
  console.log(`  Machine Name: ${MACHINE_NAME}`);
}
console.log("");

await startServer({
  port: 9315,
  host: "localhost",
  command: command!,
  args: agentArgs,
  cwd: process.cwd(),
  rcsUrl: wsUrl,
  rcsSecret: RCS_SECRET!,
  tenantId: TENANT_ID!,
  userId: USER_ID,
  labels: LABELS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  agentType: AGENT_TYPE,
  name: MACHINE_NAME || undefined,
});
