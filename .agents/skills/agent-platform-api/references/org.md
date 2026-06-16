---
name: api-org
description: 组织和 API Key 管理 API。当需要"列出组织"、"创建组织"、"管理成员"、"设置活跃组织"、"创建 API Key"、"列出 API Key"、"删除 API Key"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Organization & API Key API

管理组织（多租户）和 API Key。

> **提示**：下面示例中的 `<ORG_ID>` 占位符，操作"当前调用者所属组织"时直接用环境变量 `$USER_META_ORG_ID` 替代；对应地，涉及用户身份的 `<MEMBER_ID>` / `<USER_ID>` 在指代当前调用者本人时可用 `$USER_META_USER_ID`。

---

## 一、组织管理 — `/web/organizations`

所有组织 API 使用 `POST` + JSON body `action` 字段。

### 列出所有组织

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq '.data[] | { id, name, slug }'
```

### 获取组织详情

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get","organizationId":"<ORG_ID>"}' | jq '.data | { id, name, members: (.members | length) }'
```

### 创建组织

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","name":"新团队","slug":"new-team"}' | jq '.data | { id, name, slug }'
```

### 更新组织

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"update","organizationId":"<ORG_ID>","name":"新名称","slug":"new-slug"}' | \
  jq '.data | { id, name }'
```

### 删除组织

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete","organizationId":"<ORG_ID>"}' | jq '.data'
```

### 设置活跃组织

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"set-active","organizationId":"<ORG_ID>"}' | jq '{ success }'
```

### 列出组织成员

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list-members","organizationId":"<ORG_ID>"}' | \
  jq '.data[] | { userId, role, email }'
```

### 添加成员

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"add-member","organizationId":"<ORG_ID>","email":"user@example.com","role":"member"}' | \
  jq '.data | { userId, role }'
```

角色可选：`owner`、`admin`、`member`。

### 更新成员角色

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"update-role","organizationId":"<ORG_ID>","memberId":"<MEMBER_ID>","role":"admin"}' | \
  jq '{ success }'
```

### 移除成员

```bash
curl -s -X POST "$USER_META_BASE_URL/web/organizations" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"remove-member","organizationId":"<ORG_ID>","memberId":"<MEMBER_ID>"}' | \
  jq '{ success }'
```

---

## 二、API Key 管理 — `/web/apiKeys`

所有 API Key 操作使用 `POST` + `action` 字段。

### 列出 API Key

```bash
curl -s -X POST "$USER_META_BASE_URL/web/apiKeys" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | \
  jq '.data[] | { id, name, prefix, createdAt }'
```

注意：列表不包含完整密钥，只有 `prefix`（如 `rcs_xxx...`）。

### 创建 API Key

```bash
curl -s -X POST "$USER_META_BASE_URL/web/apiKeys" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","name":"My API Key"}' | \
  jq '.data | { id, name, key: .key }'
```

**重要**：`key` 只在创建时返回一次，之后无法再获取明文。

### 删除 API Key

```bash
curl -s -X POST "$USER_META_BASE_URL/web/apiKeys" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete","id":"<KEY_ID>"}' | jq '.data'
```
