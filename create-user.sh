#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://localhost:3000"
SYSTEM_API_KEY=""
EMAIL=""
PHONE_NUMBER=""
NAME=""
PASSWORD=""
EMAIL_VERIFIED="false"
PHONE_NUMBER_VERIFIED=""

usage() {
  cat <<'EOF'
Usage:
  ./create-user.sh --system-api-key <key> --name <name> --password <password> [--email <email>] [--phone-number <phone>] [--email-verified true|false] [--phone-number-verified true|false] [--base-url <url>]

Required args:
  --system-api-key
    服务启动时通过 RCS_SYSTEM_API_KEYS 配置的 system key
  --name
    要创建的用户名
  --password
    要创建的用户密码，至少 8 位

Optional args:
  --email
    要创建的用户邮箱；与 --phone-number 至少传一个
  --phone-number
    要创建的用户手机号；与 --email 至少传一个
  --email-verified
    是否直接标记邮箱已验证，默认 false，可传 true / false
  --phone-number-verified
    是否直接标记手机号已验证；不传时不写入该字段
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
    --password supersecret123

Phone example:
  ./create-user.sh \
    --system-api-key 123456 \
    --base-url http://localhost:3000 \
    --phone-number 18826480215 \
    --name "Phone Demo User" \
    --password supersecret123
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
    --phone-number)
      PHONE_NUMBER="${2:-}"
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
    --phone-number-verified)
      PHONE_NUMBER_VERIFIED="${2:-}"
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
require_value "--name" "$NAME"
require_value "--password" "$PASSWORD"

if [[ -z "${EMAIL// }" && -z "${PHONE_NUMBER// }" ]]; then
  echo "At least one of --email or --phone-number is required" >&2
  exit 1
fi

if [[ "$EMAIL_VERIFIED" != "true" && "$EMAIL_VERIFIED" != "false" ]]; then
  echo "--email-verified must be true or false" >&2
  exit 1
fi

if [[ -n "$PHONE_NUMBER_VERIFIED" && "$PHONE_NUMBER_VERIFIED" != "true" && "$PHONE_NUMBER_VERIFIED" != "false" ]]; then
  echo "--phone-number-verified must be true or false" >&2
  exit 1
fi

BASE_URL="${BASE_URL%/}"
REQUEST_URL="${BASE_URL}/api/system/users"
REQUEST_BODY="{"
if [[ -n "${EMAIL// }" ]]; then
  REQUEST_BODY="${REQUEST_BODY}\"email\":\"$(json_escape "$EMAIL")\","
fi
if [[ -n "${PHONE_NUMBER// }" ]]; then
  REQUEST_BODY="${REQUEST_BODY}\"phoneNumber\":\"$(json_escape "$PHONE_NUMBER")\","
fi
REQUEST_BODY="${REQUEST_BODY}\"name\":\"$(json_escape "$NAME")\",\"password\":\"$(json_escape "$PASSWORD")\",\"emailVerified\":$EMAIL_VERIFIED"
if [[ -n "$PHONE_NUMBER_VERIFIED" ]]; then
  REQUEST_BODY="${REQUEST_BODY},\"phoneNumberVerified\":$PHONE_NUMBER_VERIFIED"
fi
REQUEST_BODY="${REQUEST_BODY}}"

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
