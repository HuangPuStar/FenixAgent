#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://localhost:3000"
SYSTEM_API_KEY=""
EMAIL=""
NAME=""
PASSWORD=""
EMAIL_VERIFIED="false"

usage() {
  cat <<'EOF'
Usage:
  ./create-user.sh --system-api-key <key> --email <email> --name <name> --password <password> [--email-verified true|false] [--base-url <url>]

Required args:
  --system-api-key
    服务启动时通过 RCS_SYSTEM_API_KEYS 配置的 system key
  --email
    要创建的用户邮箱
  --name
    要创建的用户名
  --password
    要创建的用户密码，至少 8 位

Optional args:
  --email-verified
    是否直接标记邮箱已验证，默认 false，可传 true / false
  --base-url
    Fenix 服务地址，默认是 http://localhost:3000
  -h, --help
    查看帮助

Example:
  ./create-user.sh \
    --system-api-key 123456 \
    --base-url http://localhost:3000 \
    --email system-demo@example.com \
    --name "System Demo User" \
    --password supersecret123 \
    --email-verified true
EOF
}

require_value() {
  local name="$1"
  local value="$2"

  if [[ -z "${value// }" ]]; then
    echo "Missing required arg: ${name}" >&2
    exit 1
  fi
}

json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system-api-key)
      SYSTEM_API_KEY="${2:-}"
      shift 2
      ;;
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --name)
      NAME="${2:-}"
      shift 2
      ;;
    --password)
      PASSWORD="${2:-}"
      shift 2
      ;;
    --email-verified)
      EMAIL_VERIFIED="${2:-}"
      shift 2
      ;;
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_value "--system-api-key" "$SYSTEM_API_KEY"
require_value "--email" "$EMAIL"
require_value "--name" "$NAME"
require_value "--password" "$PASSWORD"

if [[ "$EMAIL_VERIFIED" != "true" && "$EMAIL_VERIFIED" != "false" ]]; then
  echo "--email-verified must be true or false" >&2
  exit 1
fi

BASE_URL="${BASE_URL%/}"
REQUEST_URL="${BASE_URL}/api/system/users"
REQUEST_BODY=$(cat <<EOF
{"email":"$(json_escape "$EMAIL")","name":"$(json_escape "$NAME")","password":"$(json_escape "$PASSWORD")","emailVerified":$EMAIL_VERIFIED}
EOF
)

echo "=== POST /api/system/users ==="
echo "$REQUEST_BODY"
echo ""

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${SYSTEM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY" \
  "$REQUEST_URL"

echo ""
