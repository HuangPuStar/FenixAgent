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
  jq '.[] | { id, name, slug, description }'
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
  }' | jq '.'
```

`slug` 用于 URL 标识，可选字段。

## 查询知识库详情

```bash
curl -s "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq .
```

## 更新知识库

```bash
curl -s -X PATCH "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"新名称","description":"新描述"}' | jq .
```

## 删除知识库

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '{ ok: .ok }'
```

## 上传文件到知识库

```bash
curl -s -X POST "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>/resources/upload" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -F "files=@./document.pdf" \
  -F "files=@./readme.md" | \
  jq '.items | length'
```

支持多文件上传，返回 `items` 数组。

## 导入 URL 资源

```bash
curl -s -X POST "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>/resources/url" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/doc","sourceName":"外部文档"}' | jq '.'
```

`sourceName` 可选。

## 列出知识库资源

```bash
curl -s "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>/resources" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.[] | { id, name, type, status }'
```

## 删除知识库资源

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/knowledgeBases/<KB_ID>/resources/<RESOURCE_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq .
```
