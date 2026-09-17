#!/usr/bin/env bash
# 测试 OpenAI Chat API 兼容端点
# 用法: bash test-openai-chat.sh <base_url> <api_key> <agent_config_id>
#   agent_config_id: agent_config 表的主键，URL 路径 /api/agents/:agentConfigId/v1/chat/completions 中的占位参数

set -uo pipefail

BASE_URL="${1:-http://localhost:3000}"
API_KEY="${2:-}"
AGENT_ID="${3:-}"

if [ -z "$API_KEY" ] || [ -z "$AGENT_ID" ]; then
  echo "用法: bash test-openai-chat.sh <base_url> <api_key> <agent_config_id>"
  echo "示例: bash test-openai-chat.sh http://localhost:3000 rcs_xxx uuid"
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass=0
fail=0

check() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    ((pass++))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    期望包含: $expected"
    echo "    实际返回: $(echo "$actual" | head -c 200 | tr '\n' ' ')"
    ((fail++))
  fi
}

assert_status() {
  local desc="$1" expected="$2" actual="$3" body="$4"
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}✓${NC} $desc (HTTP $expected)"
    ((pass++))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    期望: HTTP $expected, 实际: HTTP $actual"
    echo "    响应: $(echo "$body" | head -c 200)"
    ((fail++))
  fi
}

echo "============================================"
echo "  OpenAI Chat API 测试"
echo "  URL:  $BASE_URL/api/agents/:agentConfigId/v1/chat/completions"
echo "============================================"
echo ""

# ── 1. 非流式: Authorization: Bearer ──
echo "── 1. 非流式请求 (Authorization: Bearer) ──"
RESP=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"说一句话，二十字以内"}]}' --max-time 120 2>&1)
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

assert_status "状态码 200" "200" "$HTTP_CODE" "$BODY"
check "object 字段" '"object":"chat.completion"' "$BODY"
check "role=assistant" '"role":"assistant"' "$BODY"
check "id 前缀 chatcmpl-" '"id":"chatcmpl-' "$BODY"
check "finish_reason=end_turn" '"finish_reason":"end_turn"' "$BODY"

# 验证 content 非空
CONTENT=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null || echo "")
if [ -n "$CONTENT" ] && [ "$CONTENT" != "null" ]; then
  echo -e "  ${GREEN}✓${NC} content 非空: ${CONTENT:0:60}"
  ((pass++))
else
  echo -e "  ${RED}✗${NC} content 为空或 null"
  ((fail++))
fi
echo ""

# ── 2. 流式请求 (SSE) ──
echo "── 2. 流式请求 (stream=true) ──"
STREAM_RESP=$(curl -s -w "\n%{http_code}" --max-time 60 \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"说一句话"}],"stream":true}' 2>&1)
STREAM_CODE=$(echo "$STREAM_RESP" | tail -1)
STREAM_BODY=$(echo "$STREAM_RESP" | sed '$d')

assert_status "状态码 200" "200" "$STREAM_CODE" "$STREAM_BODY"
check "包含 [DONE]" "[DONE]" "$STREAM_BODY"
check "包含 chat.completion.chunk" "chat.completion.chunk" "$STREAM_BODY"

# 检查 Content-Type header
CT=$(curl -s -o /dev/null -w '%{content_type}' \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"说一句话"}],"stream":true}' --max-time 60)
check "Content-Type=text/event-stream" "text/event-stream" "$CT"

# 验证至少有一个 chunk 携带非空 delta.content
DELTA_CONTENT_COUNT=$(echo "$STREAM_BODY" | grep -o '"delta":{"content":"[^"]*"' | grep -v '""}' | wc -l | tr -d ' ')
if [ "$DELTA_CONTENT_COUNT" -gt 0 ] 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} 有 $DELTA_CONTENT_COUNT 个携带非空 content 的 delta chunk"
  ((pass++))
else
  echo -e "  ${RED}✗${NC} 没有找到携带非空 content 的 delta chunk"
  ((fail++))
fi

# 验证最后一个 data chunk 包含 finish_reason
check "最后一个 chunk 包含 finish_reason" '"finish_reason":"end_turn"' "$STREAM_BODY"
echo ""

# ── 3. x-api-key header 认证 ──
echo "── 3. x-api-key header 认证 ──"
RESP_XKEY=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/v1/chat/completions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"说一句话"}]}' --max-time 120 2>&1)
HTTP_XKEY=$(echo "$RESP_XKEY" | tail -1)
BODY_XKEY=$(echo "$RESP_XKEY" | sed '$d')

assert_status "状态码 200" "200" "$HTTP_XKEY" "$BODY_XKEY"
check "role=assistant" '"role":"assistant"' "$BODY_XKEY"
check "finish_reason=end_turn" '"finish_reason":"end_turn"' "$BODY_XKEY"

CONTENT_XKEY=$(echo "$BODY_XKEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null || echo "")
if [ -n "$CONTENT_XKEY" ] && [ "$CONTENT_XKEY" != "null" ]; then
  echo -e "  ${GREEN}✓${NC} content 非空: ${CONTENT_XKEY:0:60}"
  ((pass++))
else
  echo -e "  ${RED}✗${NC} content 为空或 null"
  ((fail++))
fi
echo ""

# ── 4. 错误场景: 缺少 user 消息 ──
echo "── 4. 错误场景: 缺少 user 消息 ──"
ERR=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"system","content":"You are a bot"}]}' 2>&1)
ERR_CODE=$(echo "$ERR" | tail -1)
ERR_BODY=$(echo "$ERR" | sed '$d')

assert_status "状态码 400" "400" "$ERR_CODE" "$ERR_BODY"
check "包含 error 字段" '"error"' "$ERR_BODY"
check "error.message 非空" '"message":"' "$ERR_BODY"
check "error.type=invalid_request_error" "invalid_request_error" "$ERR_BODY"
echo ""

# ── 5. 认证失败 ──
echo "── 5. 错误场景: 无效 API Key ──"
ERR_AUTH=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/agents/$AGENT_ID/v1/chat/completions" \
  -H "Authorization: Bearer invalid-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}' 2>&1)
ERR_AUTH_CODE=$(echo "$ERR_AUTH" | tail -1)
ERR_AUTH_BODY=$(echo "$ERR_AUTH" | sed '$d')

assert_status "状态码 401" "401" "$ERR_AUTH_CODE" "$ERR_AUTH_BODY"
check "包含 error 字段" '"error"' "$ERR_AUTH_BODY"
echo ""

# ── 6. Agent 不存在 ──
echo "── 6. 错误场景: Agent 不存在 ──"
ERR_404=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/agents/nonexistent-agent-999/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}' 2>&1)
ERR_404_CODE=$(echo "$ERR_404" | tail -1)
ERR_404_BODY=$(echo "$ERR_404" | sed '$d')

check "状态码 4xx 或 5xx" "4[0-9][0-9]\|5[0-9][0-9]" "$ERR_404_CODE"
check "包含 error 信息" '"error"' "$ERR_404_BODY"
check "包含 not found 提示" "not found" "$ERR_404_BODY"
echo ""

# ── 7. 并发请求 ──
echo "── 7. 并发请求 (3 个同时) ──"
TMPDIR=$(mktemp -d)
CONCURRENT=3
for i in $(seq 1 $CONCURRENT); do
  (
    curl -s -o "$TMPDIR/result_$i.json" -w "%{http_code}" \
      -X POST "$BASE_URL/api/agents/$AGENT_ID/v1/chat/completions" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"messages\":[{\"role\":\"user\",\"content\":\"回复数字 $i\"}]}" \
      --max-time 120 > "$TMPDIR/code_$i.txt" 2>/dev/null
  ) &
done
wait

concurrent_pass=0
for i in $(seq 1 $CONCURRENT); do
  HTTP=$(cat "$TMPDIR/code_$i.txt" 2>/dev/null || echo "000")
  CONTENT=$(python3 -c "
import sys, json
with open('$TMPDIR/result_$i.json') as f:
    d = json.load(f)
    c = d['choices'][0]['message']['content']
    print(c)
" 2>/dev/null || echo "")
  if [ "$HTTP" = "200" ] && [ -n "$CONTENT" ] && [ "$CONTENT" != "null" ]; then
    echo -e "  ${GREEN}✓${NC} 请求 $i: HTTP 200, content: ${CONTENT:0:50}"
    ((concurrent_pass++))
  else
    echo -e "  ${RED}✗${NC} 请求 $i: HTTP $HTTP"
    ((fail++))
  fi
done
pass=$((pass + concurrent_pass))
rm -rf "$TMPDIR"
echo ""

# ── 汇总 ──
echo "============================================"
echo -e "  总计: ${GREEN}$pass 通过${NC} / ${RED}$fail 失败${NC}"
echo "============================================"

# 退出码反映结果
if [ "$fail" -gt 0 ]; then
  exit 1
fi
