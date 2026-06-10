#!/usr/bin/env bun
/**
 * 远程 Runtime 节点启动入口 — 可通过 `bun build` 打包为独立 JS 文件。
 *
 * 用法:
 *   bun scripts/start-remote-runtime.ts <agent-command> [agent-args...]
 *
 * 环境变量:
 *   RCS_URL             WS base URL (wss://rcs.example.com)，设置后忽略 HOST/PORT
 *   RCS_HOST            RCS 地址 (默认 localhost)
 *   RCS_PORT            RCS 端口 (默认 3000)
 *   RCS_SECRET          注册密钥 (默认 rcs-registry-secret)
 *   RCS_TENANT_ID       组织 ID (必填)
 *   RCS_USER_ID         用户 ID (可选)
 *   RCS_LABELS          节点标签，逗号分隔 (默认 remote-runtime)
 *   RCS_MACHINE_NAME    机器显示名称 (可选，不传则使用 hostname)
 *   AGENT_TYPE          Agent 类型: opencode (默认) 或 ccb (Claude Code)
 *
 * 工作区路径: workspace 根目录为启动目录 (cwd)，实例路径自动按
 *   {cwd}/{organizationId}/{userId}/{environmentId} 计算。
 */

import { startServer } from "../packages/acp-link/src/server";

// ── 配置 ──
const RCS_HOST = process.env.RCS_HOST || "localhost";
const RCS_PORT = process.env.RCS_PORT || "3000";
const RCS_SECRET = process.env.RCS_SECRET || "rcs-registry-secret";
const RCS_URL = process.env.RCS_URL || "";
const TENANT_ID = process.env.RCS_TENANT_ID || "";
const USER_ID = process.env.RCS_USER_ID || "";
const LABELS = process.env.RCS_LABELS || "remote-runtime";
const MACHINE_NAME = process.env.RCS_MACHINE_NAME || "";
const AGENT_TYPE = (process.env.AGENT_TYPE || "opencode") as "opencode" | "ccb";
// ──────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("启动远程 Runtime 节点 — 连接到 RCS 主服务器");
  console.log("");
  console.log("用法: bun start-remote-runtime.ts <agent-command> [agent-args...]");
  console.log("");
  console.log("示例:");
  console.log("  RCS_TENANT_ID=xxx bun start-remote-runtime.ts opencode acp");
  console.log("  AGENT_TYPE=ccb RCS_TENANT_ID=xxx bun start-remote-runtime.ts npx @anthropic-ai/claude-code --acp");
  console.log("");
  console.log("环境变量:");
  console.log("  RCS_URL             WS base URL (scheme://host:port)，如 wss://rcs.example.com");
  console.log("  RCS_HOST            RCS 地址 (默认 localhost)");
  console.log("  RCS_PORT            RCS 端口 (默认 3000)");
  console.log("  RCS_SECRET          注册密钥 (默认 rcs-registry-secret)");
  console.log("  RCS_TENANT_ID       组织 ID (必填)");
  console.log("  RCS_USER_ID         用户 ID (可选)");
  console.log("  RCS_LABELS          节点标签，逗号分隔 (默认 remote-runtime)");
  console.log("  RCS_MACHINE_NAME    机器显示名称 (可选，不传则使用 hostname)");
  console.log("  AGENT_TYPE          Agent 类型: opencode (默认) 或 ccb (Claude Code)");
  process.exit(1);
}

// 确定 WS URL
const wsUrl = RCS_URL || `ws://${RCS_HOST}:${RCS_PORT}`;

// 健康检查
const httpUrl = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
try {
  const res = await fetch(`${httpUrl}/docs/api`);
  if (!res.ok) throw new Error(`status ${res.status}`);
} catch {
  console.error(`RCS (${wsUrl}) 未响应，请先启动 RCS`);
  process.exit(1);
}

const [command, ...agentArgs] = args;

console.log(`RCS 在线 (${wsUrl})`);
console.log(`启动远程 Runtime 节点...`);
console.log(`  Agent:        ${command} ${agentArgs.join(" ")}`);
console.log(`  Agent Type:   ${AGENT_TYPE}`);
console.log(`  Workspace:    ${process.cwd()} (cwd)`);
console.log(`  Tenant:       ${TENANT_ID || "无"}`);
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
  rcsSecret: RCS_SECRET,
  tenantId: TENANT_ID,
  userId: USER_ID,
  labels: LABELS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  agentType: AGENT_TYPE,
  name: MACHINE_NAME || undefined,
});
