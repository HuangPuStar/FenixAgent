#!/usr/bin/env bash
# 注册远程机器到 RCS 的启动脚本
# 用法: ./scripts/register-machine.sh <agent-command> [agent-args...]
# 示例:
#   RCS_TENANT_ID=xxx ./scripts/register-machine.sh opencode acp
#   RCS_TENANT_ID=xxx ./scripts/register-machine.sh npx @anthropic-ai/claude-code --acp
#   RCS_TENANT_ID=xxx ./scripts/register-machine.sh /path/to/custom-agent
set -euo pipefail

# ── 配置 ──
RCS_HOST="${RCS_HOST:-localhost}"
RCS_PORT="${RCS_PORT:-3000}"
RCS_SECRET="${RCS_SECRET:-rcs-registry-secret}"
TENANT_ID="${RCS_TENANT_ID:-}"
USER_ID="${RCS_USER_ID:-}"
LABELS="${RCS_LABELS:-local-dev}"
# ──────────

if [ $# -eq 0 ]; then
  echo "用法: $0 <agent-command> [agent-args...]"
  echo ""
  echo "示例:"
  echo "  RCS_TENANT_ID=xxx $0 opencode acp"
  echo "  RCS_TENANT_ID=xxx $0 npx @anthropic-ai/claude-code --acp"
  echo ""
  echo "环境变量:"
  echo "  RCS_HOST        RCS 地址 (默认 localhost)"
  echo "  RCS_PORT        RCS 端口 (默认 3000)"
  echo "  RCS_SECRET      注册密钥 (默认 rcs-registry-secret)"
  echo "  RCS_TENANT_ID   组织 ID (必填)"
  echo "  RCS_USER_ID     用户 ID (可选)"
  echo "  RCS_LABELS      机器标签，逗号分隔 (默认 local-dev)"
  exit 1
fi

AGENT_COMMAND="$1"
shift
AGENT_ARGS=("$@")

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! curl -sf "http://${RCS_HOST}:${RCS_PORT}/docs/swagger" -o /dev/null 2>/dev/null; then
  echo "❌ RCS (${RCS_HOST}:${RCS_PORT}) 未响应，请先启动 RCS"
  exit 1
fi

echo "✅ RCS 在线 (${RCS_HOST}:${RCS_PORT})"
echo "🚀 启动 acp-link..."
echo "   Agent: ${AGENT_COMMAND} ${AGENT_ARGS[*]}"
echo "   Tenant: ${TENANT_ID:-无}"
echo "   Labels: ${LABELS}"
echo ""

exec bun "${PROJECT_ROOT}/packages/acp-link/src/cli/bin.ts" \
  --rcs-url "ws://${RCS_HOST}:${RCS_PORT}" \
  --rcs-secret "$RCS_SECRET" \
  ${TENANT_ID:+--tenant-id "$TENANT_ID"} \
  ${USER_ID:+--user-id "$USER_ID"} \
  --labels "$LABELS" \
  "$AGENT_COMMAND" -- "${AGENT_ARGS[@]}"
