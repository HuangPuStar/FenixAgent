#!/usr/bin/env bash
# 启动远程 Runtime 节点 — 连接到 RCS 主服务器，作为远程 EngineRuntime 接受调度
#
# 工作流程:
#   1. acp-link 以 client mode 连接到 RCS 的 /acp/ws
#   2. 注册为远程 machine node
#   3. RCS 通过 EngineRuntime 协议下发 prepare（装配环境）→ start（spawn agent）→ relay（转发消息）
#   4. 断线自动指数退避重连，不杀子进程
#
# 用法: ./scripts/start-remote-runtime.sh [agent-command] [agent-args...]
# 示例:
#   RCS_TENANT_ID=xxx ./scripts/start-remote-runtime.sh opencode acp
#   RCS_TENANT_ID=xxx ./scripts/start-remote-runtime.sh npx @anthropic-ai/claude-code --acp
#   RCS_TENANT_ID=xxx ./scripts/start-remote-runtime.sh
set -euo pipefail

# ── 配置 ──
RCS_HOST="${RCS_HOST:-localhost}"
RCS_PORT="${RCS_PORT:-3000}"
RCS_SECRET="${RCS_SECRET:-rcs-registry-secret}"
RCS_URL="${RCS_URL:-}"                # 完整 WS URL，设置后忽略 RCS_HOST/RCS_PORT
TENANT_ID="${RCS_TENANT_ID:-}"
USER_ID="${RCS_USER_ID:-}"
LABELS="${RCS_LABELS:-remote-runtime}"
WORKSPACE_ROOT="${RCS_WORKSPACE_ROOT:-$HOME/.rcs/workspaces}"
# ──────────

if [ $# -eq 0 ]; then
  echo "启动远程 Runtime 节点 — 连接到 RCS 主服务器"
  echo ""
  echo "用法: $0 [agent-command] [agent-args...]"
  echo ""
  echo "示例:"
  echo "  RCS_TENANT_ID=xxx $0 opencode acp"
  echo "  RCS_TENANT_ID=xxx $0 npx @anthropic-ai/claude-code --acp"
  echo ""
  echo "环境变量:"
  echo "  RCS_HOST            RCS 地址 (默认 localhost)"
  echo "  RCS_PORT            RCS 端口 (默认 3000)"
  echo "  RCS_URL             完整 WS URL，如 wss://rcs.example.com (设置后忽略 HOST/PORT)"
  echo "  RCS_SECRET          注册密钥 (默认 rcs-registry-secret)"
  echo "  RCS_TENANT_ID       组织 ID (必填)"
  echo "  RCS_USER_ID         用户 ID (可选)"
  echo "  RCS_LABELS          节点标签，逗号分隔 (默认 remote-runtime)"
  echo "  RCS_WORKSPACE_ROOT  工作区根目录 (默认 ~/.rcs/workspaces)"
  exit 1
fi

AGENT_COMMAND="$1"
shift
AGENT_ARGS=("$@")

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 确定 WS URL
if [ -n "$RCS_URL" ]; then
  WS_URL="$RCS_URL"
else
  WS_URL="ws://${RCS_HOST}:${RCS_PORT}"
fi

# 健康检查
HTTP_URL="${WS_URL/ws:/http:}"
HTTP_URL="${HTTP_URL/wss:/https:}"
if ! curl -sf "${HTTP_URL}/docs/swagger" -o /dev/null 2>/dev/null; then
  echo "❌ RCS (${WS_URL}) 未响应，请先启动 RCS"
  exit 1
fi

echo "✅ RCS 在线 (${WS_URL})"
echo "🚀 启动远程 Runtime 节点..."
echo "   Agent:        ${AGENT_COMMAND} ${AGENT_ARGS[*]}"
echo "   Workspace:    ${WORKSPACE_ROOT}"
echo "   Tenant:       ${TENANT_ID:-无}"
echo "   Labels:       ${LABELS}"
echo ""

exec bun "${PROJECT_ROOT}/packages/acp-link/src/cli/bin.ts" \
  --rcs-url "$WS_URL" \
  --rcs-secret "$RCS_SECRET" \
  ${TENANT_ID:+--tenant-id "$TENANT_ID"} \
  ${USER_ID:+--user-id "$USER_ID"} \
  --labels "$LABELS" \
  "$AGENT_COMMAND" -- "${AGENT_ARGS[@]}"
