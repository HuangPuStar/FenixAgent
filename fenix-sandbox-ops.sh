#!/usr/bin/env bash

# FenixAgent / OpenSandbox Cluster 日常运维脚本。
# 所有接口都通过现有 HTTP API 调用，不直接操作数据库。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

load_dotenv() {
  local env_file="$1"
  local line name value first_char last_char

  [[ -f "$env_file" ]] || return 0

  # 只解析脚本需要的 KEY=VALUE 行，不执行 .env 中的任意内容。
  # 这样可以兼容包含多行提示文本或其他应用配置的项目级 .env。
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(RCS_SANDBOX_CLUSTER_URL|RCS_BASE_URL|RCS_SANDBOX_CLUSTER_API_KEY|RCS_SYSTEM_API_KEYS)[[:space:]]*=(.*)$ ]]; then
      name="${BASH_REMATCH[2]}"
      value="${BASH_REMATCH[3]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if (( ${#value} >= 2 )); then
        first_char="${value:0:1}"
        last_char="${value: -1}"
        if [[ ( "$first_char" == '"' && "$last_char" == '"' ) || ( "$first_char" == "'" && "$last_char" == "'" ) ]]; then
          value="${value:1:${#value}-2}"
        fi
      fi
      case "$name" in
        RCS_SANDBOX_CLUSTER_URL) [[ ${RCS_SANDBOX_CLUSTER_URL+x} ]] && continue ;;
        RCS_BASE_URL) [[ ${RCS_BASE_URL+x} ]] && continue ;;
        RCS_SANDBOX_CLUSTER_API_KEY) [[ ${RCS_SANDBOX_CLUSTER_API_KEY+x} ]] && continue ;;
        RCS_SYSTEM_API_KEYS) [[ ${RCS_SYSTEM_API_KEYS+x} ]] && continue ;;
      esac
      printf -v "$name" '%s' "$value"
    fi
  done < "$env_file"
}

load_dotenv "$SCRIPT_DIR/.env"

RCS_SANDBOX_CLUSTER_URL="${RCS_SANDBOX_CLUSTER_URL:-http://127.0.0.1:8080}"
RCS_BASE_URL="${RCS_BASE_URL:-http://127.0.0.1:3000}"
RCS_SANDBOX_CLUSTER_API_KEY="${RCS_SANDBOX_CLUSTER_API_KEY:-}"
RCS_SYSTEM_API_KEYS="${RCS_SYSTEM_API_KEYS:-}"

usage() {
  cat <<'EOF'
用法：
  fenix-sandbox-ops.sh health cluster|fenix

  fenix-sandbox-ops.sh cluster pool list
  fenix-sandbox-ops.sh cluster pool get <pool_id>
  fenix-sandbox-ops.sh cluster pool create <json|@file>
  fenix-sandbox-ops.sh cluster pool update <pool_id> <json|@file>
  fenix-sandbox-ops.sh cluster pool delete <pool_id> [--yes]

  fenix-sandbox-ops.sh cluster server list [pool_id]
  fenix-sandbox-ops.sh cluster server get <server_id>
  fenix-sandbox-ops.sh cluster server create <json|@file>
  fenix-sandbox-ops.sh cluster server update <server_id> <json|@file>
  fenix-sandbox-ops.sh cluster server delete <server_id> [--yes]
  fenix-sandbox-ops.sh cluster server health-check <server_id>

  fenix-sandbox-ops.sh fenix sandbox list [query]
  fenix-sandbox-ops.sh fenix sandbox get <instance_id>
  fenix-sandbox-ops.sh fenix sandbox update <instance_id> <json|@file>
  fenix-sandbox-ops.sh fenix sandbox delete <instance_id> [--yes]
  fenix-sandbox-ops.sh fenix sandbox rebuild-all <pool_id> [--dry-run] [--yes]
  fenix-sandbox-ops.sh fenix sandbox rebuild-instance <pool_id> <instance_id> [--dry-run] [--yes]
  fenix-sandbox-ops.sh fenix sandbox rebuild-user <pool_id> <user_id> [--dry-run] [--yes]

环境变量：
  RCS_SANDBOX_CLUSTER_URL       Cluster 地址（默认：http://127.0.0.1:8080）
  RCS_SANDBOX_CLUSTER_API_KEY   Cluster 服务 API Key
  RCS_BASE_URL                  Fenix 地址（默认：http://127.0.0.1:3000）
  RCS_SYSTEM_API_KEYS           Fenix 系统 API Key（逗号分隔时使用第一个）

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
      [[ -n "$RCS_SANDBOX_CLUSTER_API_KEY" ]] || die "必须配置 RCS_SANDBOX_CLUSTER_API_KEY"
      ;;
    fenix)
      [[ -n "$RCS_SYSTEM_API_KEYS" ]] || die "必须配置 RCS_SYSTEM_API_KEYS"
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
    base_url="${RCS_SANDBOX_CLUSTER_URL%/}"
    api_key="$RCS_SANDBOX_CLUSTER_API_KEY"
  else
    require_key fenix
    base_url="${RCS_BASE_URL%/}"
    api_key="${RCS_SYSTEM_API_KEYS%%,*}"
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
    cluster) curl -fsS "${RCS_SANDBOX_CLUSTER_URL%/}/health"; printf '\n' ;;
    fenix) curl -fsS "${RCS_BASE_URL%/}/health"; printf '\n' ;;
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
    update) [[ $# -eq 3 ]] || die "用法：fenix sandbox update <instance_id> <json|@file>"; request fenix PUT "/api/system/sandbox-instances/$2" "$3" ;;
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
