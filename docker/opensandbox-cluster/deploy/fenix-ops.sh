#!/usr/bin/env bash

# FenixAgent / OpenSandbox Cluster 日常运维脚本。
# 所有接口都通过现有 HTTP API 调用，不直接操作数据库。
set -euo pipefail

CLUSTER_URL="${CLUSTER_URL:-http://127.0.0.1:8080}"
FENIX_URL="${FENIX_URL:-http://127.0.0.1:3000}"
CLUSTER_API_KEY="${CLUSTER_API_KEY:-}"
FENIX_SYSTEM_API_KEY="${FENIX_SYSTEM_API_KEY:-}"

usage() {
  cat <<'EOF'
用法：
  fenix-ops.sh health cluster|fenix

  fenix-ops.sh cluster pool list
  fenix-ops.sh cluster pool get <pool_id>
  fenix-ops.sh cluster pool create <json|@file>
  fenix-ops.sh cluster pool update <pool_id> <json|@file>
  fenix-ops.sh cluster pool delete <pool_id> [--yes]

  fenix-ops.sh cluster server list [pool_id]
  fenix-ops.sh cluster server get <server_id>
  fenix-ops.sh cluster server create <json|@file>
  fenix-ops.sh cluster server update <server_id> <json|@file>
  fenix-ops.sh cluster server delete <server_id> [--yes]
  fenix-ops.sh cluster server health-check <server_id>

  fenix-ops.sh fenix sandbox list [query]
  fenix-ops.sh fenix sandbox get <instance_id>
  fenix-ops.sh fenix sandbox delete <instance_id> [--yes]
  fenix-ops.sh fenix sandbox rebuild-all <pool_id> [--dry-run] [--yes]
  fenix-ops.sh fenix sandbox rebuild-instance <pool_id> <instance_id> [--dry-run] [--yes]
  fenix-ops.sh fenix sandbox rebuild-user <pool_id> <user_id> [--dry-run] [--yes]

环境变量：
  CLUSTER_URL             Cluster 地址（默认：http://127.0.0.1:8080）
  CLUSTER_API_KEY         Cluster 服务 API Key
  FENIX_URL               Fenix 地址（默认：http://127.0.0.1:3000）
  FENIX_SYSTEM_API_KEY    Fenix 的 RCS_SYSTEM_API_KEYS 值

JSON 参数支持直接传 JSON，也支持传入 @/path/to/body.json 文件。
EOF
}

die() {
  echo "错误：$*" >&2
  exit 2
}

require_key() {
  case "$1" in
    cluster)
      [[ -n "$CLUSTER_API_KEY" ]] || die "必须配置 CLUSTER_API_KEY"
      ;;
    fenix)
      [[ -n "$FENIX_SYSTEM_API_KEY" ]] || die "必须配置 FENIX_SYSTEM_API_KEY"
      ;;
  esac
}

normalize_json() {
  local value="$1"
  if [[ "$value" == @* ]]; then
    [[ -f "${value#@}" ]] || die "JSON 文件不存在：${value#@}"
    cat "${value#@}"
  else
    printf '%s' "$value"
  fi
}

request() {
  local service="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  local base_url api_key response status response_body

  if [[ "$service" == "cluster" ]]; then
    require_key cluster
    base_url="${CLUSTER_URL%/}"
    api_key="$CLUSTER_API_KEY"
  else
    require_key fenix
    base_url="${FENIX_URL%/}"
    api_key="$FENIX_SYSTEM_API_KEY"
  fi

  if [[ -n "$body" ]]; then
    response=$(curl -sS -X "$method" \
      -H "Authorization: Bearer $api_key" \
      -H "Content-Type: application/json" \
      --data-binary "$(normalize_json "$body")" \
      -w $'\n%{http_code}' \
      "${base_url}${path}")
  else
    response=$(curl -sS -X "$method" \
      -H "Authorization: Bearer $api_key" \
      -w $'\n%{http_code}' \
      "${base_url}${path}")
  fi

  status="${response##*$'\n'}"
  response_body="${response%$'\n'*}"
  printf '%s\n' "$response_body"
  printf 'HTTP 状态：%s\n' "$status" >&2

  if (( status < 200 || status >= 300 )); then
    return 1
  fi
}

confirm() {
  local action="$1"
  local last_arg="${!#}"
  [[ "$last_arg" == "--yes" ]] && return
  read -r -p "About to ${action}. Continue? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || die "操作已取消"
}

health() {
  case "${1:-}" in
    cluster) curl -fsS "${CLUSTER_URL%/}/health"; printf '\n' ;;
    fenix) curl -fsS "${FENIX_URL%/}/health"; printf '\n' ;;
    *) die "health 参数必须是 cluster 或 fenix" ;;
  esac
}

cluster_pool() {
  require_key cluster
  case "${1:-}" in
    list) request cluster GET "/api/v1/pools" ;;
    get) [[ $# -eq 2 ]] || die "用法：cluster pool get <pool_id>"; request cluster GET "/api/v1/pools/$2" ;;
    create) [[ $# -eq 2 ]] || die "用法：cluster pool create <json|@file>"; request cluster POST "/api/v1/pools" "$2" ;;
    update) [[ $# -eq 3 ]] || die "用法：cluster pool update <pool_id> <json|@file>"; request cluster PUT "/api/v1/pools/$2" "$3" ;;
    delete) [[ $# -ge 2 && $# -le 3 ]] || die "用法：cluster pool delete <pool_id> [--yes]"; confirm "删除 Cluster 资源池 '$2'"; request cluster DELETE "/api/v1/pools/$2" ;;
    *) die "未知的 Cluster 资源池操作" ;;
  esac
}

cluster_server() {
  require_key cluster
  case "${1:-}" in
    list)
      if [[ $# -eq 2 ]]; then request cluster GET "/api/v1/servers?pool_id=$2"; else request cluster GET "/api/v1/servers"; fi
      ;;
    get) [[ $# -eq 2 ]] || die "用法：cluster server get <server_id>"; request cluster GET "/api/v1/servers/$2" ;;
    create) [[ $# -eq 2 ]] || die "用法：cluster server create <json|@file>"; request cluster POST "/api/v1/servers" "$2" ;;
    update) [[ $# -eq 3 ]] || die "用法：cluster server update <server_id> <json|@file>"; request cluster PUT "/api/v1/servers/$2" "$3" ;;
    delete) [[ $# -ge 2 && $# -le 3 ]] || die "用法：cluster server delete <server_id> [--yes]"; confirm "删除 Cluster Server '$2'"; request cluster DELETE "/api/v1/servers/$2" ;;
    health-check) [[ $# -eq 2 ]] || die "用法：cluster server health-check <server_id>"; request cluster POST "/api/v1/servers/$2/health-check" ;;
    *) die "未知的 Cluster Server 操作" ;;
  esac
}

fenix_sandbox() {
  require_key fenix
  case "${1:-}" in
    list)
      if [[ $# -eq 2 ]]; then request fenix GET "/api/system/sandbox-instances?$2"; else request fenix GET "/api/system/sandbox-instances"; fi
      ;;
    get) [[ $# -eq 2 ]] || die "用法：fenix sandbox get <instance_id>"; request fenix GET "/api/system/sandbox-instances/$2" ;;
    delete) [[ $# -ge 2 && $# -le 3 ]] || die "用法：fenix sandbox delete <instance_id> [--yes]"; confirm "删除 Fenix 沙盒实例 '$2'"; request fenix DELETE "/api/system/sandbox-instances/$2" ;;
    rebuild-all)
      [[ $# -ge 2 && $# -le 4 ]] || die "用法：fenix sandbox rebuild-all <pool_id> [--dry-run] [--yes]"
      local dry_run=false
      [[ "${3:-}" == "--dry-run" || "${4:-}" == "--dry-run" ]] && dry_run=true
      confirm "重建资源池 '$2' 下的全部沙盒实例"
      request fenix POST "/api/system/sandbox-instances/rebuild" "{\"sandboxPoolId\":\"$2\",\"dryRun\":$dry_run}"
      ;;
    rebuild-instance)
      [[ $# -ge 3 && $# -le 5 ]] || die "用法：fenix sandbox rebuild-instance <pool_id> <instance_id> [--dry-run] [--yes]"
      local dry_run=false
      [[ "${4:-}" == "--dry-run" || "${5:-}" == "--dry-run" ]] && dry_run=true
      confirm "重建沙盒实例 '$3'"
      request fenix POST "/api/system/sandbox-instances/rebuild" "{\"sandboxPoolId\":\"$2\",\"instanceIds\":[\"$3\"],\"dryRun\":$dry_run}"
      ;;
    rebuild-user)
      [[ $# -ge 3 && $# -le 5 ]] || die "用法：fenix sandbox rebuild-user <pool_id> <user_id> [--dry-run] [--yes]"
      local dry_run=false
      [[ "${4:-}" == "--dry-run" || "${5:-}" == "--dry-run" ]] && dry_run=true
      confirm "重建用户 '$3' 的沙盒实例"
      request fenix POST "/api/system/sandbox-instances/rebuild" "{\"sandboxPoolId\":\"$2\",\"userIds\":[\"$3\"],\"dryRun\":$dry_run}"
      ;;
    *) die "未知的 Fenix 沙盒操作" ;;
  esac
}

main() {
  case "${1:-}" in
    health) shift; health "$@" ;;
    cluster)
      shift
      case "${1:-}" in
        pool) shift; cluster_pool "$@" ;;
        server) shift; cluster_server "$@" ;;
        *) die "用法：cluster pool|server ..." ;;
      esac
      ;;
    fenix)
      shift
      [[ "${1:-}" == "sandbox" ]] || die "用法：fenix sandbox ..."
      shift
      fenix_sandbox "$@"
      ;;
    -h|--help|"") usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
