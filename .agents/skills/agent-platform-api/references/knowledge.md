---
name: api-knowledge
description: 知识库 API。当需要"列出知识库"、"创建知识库"、"上传文件到知识库"、"导入 URL"、"管理知识库资源"、"删除知识库"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Knowledge Base API

管理知识库及其资源（文件、URL）。

## 列出所有知识库

```bash
curl -s "$USER_META_BASE_URL/web/knowledgeBases" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data[] | { id, name, slug, description }'
```

## 创建知识库

```bash
curl -s -X POST "$USER_META_BASE_URL/web/knowledgeBases" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "产品文档",
    "slug": "product-docs",
    "description": "产品相关文档集合"
  }' | jq '.data'
```

`slug` 用于 URL 标识，可选字段。

创建、更新、上传和 URL 导入都依赖已配置且可访问的 Knowledge Provider；Provider 不可用时会返回 HTTP 502 与 `KNOWLEDGE_PROVIDER_ERROR`。知识库列表不依赖该成功链路，不能据此推断 Provider 可用。

## 查询知识库详情

```bash
curl -s "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```

## 更新知识库

```bash
curl -s -X PATCH "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"新名称","description":"新描述"}' | jq '.data'
```

## 删除知识库

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```

## 上传文件到知识库

```bash
curl -s -X POST "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>/resources/upload" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -F "files=@./document.pdf" \
  -F "files=@./readme.md" | \
  jq '.data.items | length'
```

支持多文件上传，返回 `items` 数组。

## 导入 URL 资源

**当前不可用，禁止调用。** 平台会将 URL 作为 `url` multipart 字段转发，但当前 RAGFlow 的文档上传端点只接受 `file` 字段，调用会失败。待后端实现 URL 下载后按文件上传（或接入兼容的 RAGFlow URL 导入接口）后再恢复此能力。

## 列出知识库资源

```bash
curl -s "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>/resources" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data[] | { id, name, type, status }'
```

## 删除知识库资源

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>/resources/<RESOURCE_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```
