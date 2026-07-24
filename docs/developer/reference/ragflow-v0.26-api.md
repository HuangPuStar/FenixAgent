# RAGFlow v0.26.0 API 接口参考

> **版本**: v0.26.0 (2026-06-11 发布)  
> **认证方式**: 所有请求头携带 `Authorization: Bearer <YOUR_API_KEY>`。TTS/ASR 等操作需 `YOUR_LOGIN_TOKEN`。  
> **响应格式**: 成功 `{ "code": 0, "data": ... }`，失败 `{ "code": <错误码>, "message": "..." }`  
> **官方文档**: <https://ragflow.io/docs/http_api_reference>  
> **v0.26.0 重大变更**: API 全面重构为标准 RESTful 风格，旧 `/v1/*` 路径废弃（向后兼容层仍可用）

---

## 一、OpenAI 兼容 API

### Chat 补全 — `POST /api/v1/openai/{chat_id}/chat/completions`

用指定 Chat 助手的知识库/设置进行对话，兼容 OpenAI 格式。

- 废弃: `POST /api/v1/chats_openai/{chat_id}/chat/completions`

**入参 (Body JSON)**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 模型名，可用 `"model"` 占位沿用助手配置 |
| messages | list[object] | 是 | 对话消息列表 |
| stream | boolean | 否 | 是否流式输出 |
| extra_body | object | 否 | 扩展参数: `reference`(引用)、`reference_metadata`(元数据)、`metadata_condition`(过滤条件) |

**出参**: 流式为 SSE `data:` 行，非流式返回 `choices/message/content` + `usage`，均兼容 OpenAI 格式。

### Agent 补全 — `POST /api/v1/agents_openai/{agent_id}/chat/completions`

用指定 Agent 进行对话，兼容 OpenAI 格式。

**入参**: `model` / `messages` / `stream` / `session_id`(可选)

**出参**: 兼容 OpenAI 格式，额外返回 `reference.chunks`（含 chunk 内容、文档名、相似度等）。

---

## 二、Dataset（数据集/知识库）管理

### 创建 — `POST /api/v1/datasets`

**入参 (Body JSON)**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 唯一名，最大128字符，BMP |
| avatar | string | 否 | Base64 头像，最大65535字符 |
| description | string | 否 | 描述，最大65535字符 |
| embedding_model | string | 否 | 格式 `model_name@model_factory`，如 `"BAAI/bge-large-zh-v1.5@BAAI"` |
| permission | string | 否 | `"me"`(默认) 或 `"team"` |
| chunk_method | enum | 否 | `naive`/`book`/`email`/`laws`/`manual`/`one`/`paper`/`picture`/`presentation`/`qa`/`table`/`tag` |
| parser_config | object | 否 | 随 chunk_method 变化的分块配置 |
| parse_type + pipeline_id | int+string | 条件必填 | 使用自定义 ingestion pipeline 时必填（与 chunk_method 互斥） |

**parser_config（naive 分块时）**:

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| chunk_token_num | int | 512 | 分块 token 数，范围 1-2048 |
| delimiter | string | `"\n"` | 分块分隔符 |
| auto_keywords | int | 0 | 自动提取关键词数，0-32 |
| auto_questions | int | 0 | 自动生成问题数，0-10 |
| layout_recognize | string | `"DeepDOC"` | 版面识别方式 |
| html4excel | bool | false | Excel 是否转 HTML |
| task_page_size | int | 12 | PDF 每页处理数 |
| raptor | object | `{"use_raptor": false}` | RAPTOR 分层摘要 |
| graphrag | object | `{"use_graphrag": false}` | 知识图谱构建 |
| parent_child | object | `{"use_parent_child": false}` | 父子分块 |

### 列表 — `GET /api/v1/datasets`

**查询参数**: `page`(默认1) / `page_size`(默认30) / `orderby`(`create_time`/`update_time`) / `desc`(默认true) / `name` / `id` / `include_parsing_status`

### 更新 — `PUT /api/v1/datasets/{dataset_id}`

**入参**: 同创建参数（全部可选），修改 embedding_model 时需 chunk_count=0。

### 删除 — `DELETE /api/v1/datasets`

**入参**: `ids` (list[string]) 或 `delete_all` (boolean)

---

## 三、知识图谱（GraphRAG）

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 构建 | POST | `/api/v1/datasets/{dataset_id}/run_graphrag` | 构建知识图谱，返回 `graphrag_task_id` |
| 获取 | GET | `/api/v1/datasets/{dataset_id}/knowledge_graph` | 获取图谱（edges/nodes/mind_map） |
| 删除 | DELETE | `/api/v1/datasets/{dataset_id}/knowledge_graph` | 移除知识图谱 |
| 构建状态 | GET | `/api/v1/datasets/{dataset_id}/trace_graphrag` | 查询进度(0-1)、步骤日志、耗时 |

---

## 四、RAPTOR（分层摘要）

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 构建 | POST | `/api/v1/datasets/{dataset_id}/run_raptor` | 构建 RAPTOR，返回 `raptor_task_id` |
| 状态 | GET | `/api/v1/datasets/{dataset_id}/trace_raptor` | 查询构建进度 |

---

## 五、文档管理（Dataset 内）

### 上传文档 — `POST /api/v1/datasets/{dataset_id}/documents`

Query `type`: `local`(默认)/`web`/`empty`

- `local`: multipart form `file=@path`
- `web`: form `name` + `url`
- `empty`: JSON `{"name":"..."}`

### 列表文档 — `GET /api/v1/datasets/{dataset_id}/documents`

**查询参数**: `page` / `page_size` / `orderby` / `desc` / `keywords` / `id` / `name` / `create_time_from`(Unix时间戳) / `create_time_to` / `suffix`(数组:pdf,txt等) / `run`(UNSTART/RUNNING/CANCEL/DONE/FAIL) / `metadata_condition`(元数据条件过滤JSON)

### 更新文档 — `PUT /api/v1/datasets/{dataset_id}/documents/{document_id}`

**入参**: `name` / `meta_fields`(dict) / `chunk_method` / `parser_config` / `enabled`(1可用/0不可用)

### 下载文档 — `GET /api/v1/datasets/{dataset_id}/documents/{document_id}`

返回原始文件内容。

### 删除文档 — `DELETE /api/v1/datasets/{dataset_id}/documents`

**入参**: `ids` (list[string]) 或 `delete_all` (boolean)

### 解析文档 — `POST /api/v1/datasets/{dataset_id}/chunks`

**入参**: `document_ids` (list[string], 必填) — 仅限内置分块管道的数据集。

### 停止解析 — `DELETE /api/v1/datasets/{dataset_id}/chunks`

**入参**: `document_ids` (list[string], 必填)

### Ingestion — `POST /api/v1/documents/ingest`

用于 ingestion pipeline 数据集的文档处理。
**入参**: `doc_ids`(必填) + `run`(`"1"`启动/`"2"`取消) + `delete`(重跑时清旧数据，默认false)

---

## 六、Chunk（分块）管理

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 创建 | POST | `/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks` | 手动添加 chunk |
| 列表 | GET | `/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks` | 分页列出（支持 keywords/id/page/page_size） |
| 获取 | GET | `.../chunks/{chunk_id}` | 获取单个 chunk（不含向量） |
| 更新 | PATCH | `.../chunks/{chunk_id}` | 更新 chunk 内容/关键词/可用性（废弃 PUT） |
| 批量可用性 | PATCH | `.../chunks` | 批量切换 chunk 启用/禁用 |
| 删除 | DELETE | `.../chunks` | 批量/全部删除 |

**创建 chunk 入参**: `content`(string, 必填)、`important_keywords`(list)、`tag_kwd`(list)、`questions`(list)、`image_base64`(string)

**更新 chunk 入参**: `content` / `important_keywords` / `questions` / `positions` / `tag_kwd` / `available`(boolean) / `image_base64`

**批量可用性入参**: `chunk_ids`(必填) + `available_int`(0/1) 或 `available`(boolean)

---

## 七、检索（Retrieval）

### `POST /api/v1/retrieval`

**入参 (Body JSON)**:

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| question | string | 是 | - | 查询问题 |
| dataset_ids | list[string] | 条件 | - | 与 document_ids 二选一 |
| document_ids | list[string] | 条件 | - | 与 dataset_ids 二选一 |
| page | int | 否 | 1 | 页码 |
| page_size | int | 否 | 30 | 每页数 |
| similarity_threshold | float | 否 | 0.2 | 最小相似度 |
| vector_similarity_weight | float | 否 | 0.3 | 向量权重（关键词权重=1-x） |
| top_k | int | 否 | 1024 | 参与向量计算的 chunk 数 |
| rerank_id | string | 否 | - | 重排序模型 ID |
| keyword | boolean | 否 | false | 是否启用关键词匹配 |
| highlight | boolean | 否 | false | 是否高亮匹配词 |
| cross_languages | list[string] | 否 | - | 跨语言检索 |
| metadata_condition | object | 否 | - | 元数据过滤: `{logic:"and"/"or", conditions:[{name, comparison_operator, value}]}` |
| use_kg | boolean | 否 | false | 是否使用知识图谱多跳检索 |
| toc_enhance | boolean | 否 | false | 是否使用目录增强 |

**出参**: `chunks` 数组（含 `content`/`similarity`/`vector_similarity`/`term_similarity`/`document_name`/`positions`/`highlight` 等）+ `doc_aggs` 文档聚合 + `total`

---

## 八、元数据管理

### 元数据摘要 — `GET /api/v1/datasets/{dataset_id}/metadata/summary`

聚合数据集中所有文档的元数据值分布。
**出参**: `{ "summary": { "key": { "type": "string", "values": [["value", count], ...] } } }`

### 批量更新 — `POST /api/v1/datasets/{dataset_id}/metadata/update`

**入参**:

- `selector` (object, 可选): `document_ids` + `metadata_condition` 筛选目标文档
- `updates` (list[object]): `[{key, match?, value}]` — 替换元数据
- `deletes` (list[object]): `[{key, value?}]` — 删除元数据

**出参**: `{ "updated": N, "matched_docs": M }`

---

## 九、Chat 助手管理

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 创建 | POST | `/api/v1/chats` | 创建 Chat 助手 |
| 列表 | GET | `/api/v1/chats` | 分页列出，支持 keywords/name/id/owner_ids |
| 获取 | GET | `/api/v1/chats/{chat_id}` | 获取单个详情 |
| 全量更新 | PUT | `/api/v1/chats/{chat_id}` | 覆盖更新（缺省字段重置为默认值） |
| 部分更新 | PATCH | `/api/v1/chats/{chat_id}` | 合并更新（推荐） |
| 删除单个 | DELETE | `/api/v1/chats/{chat_id}` | 按 ID 删除 |
| 批量删除 | DELETE | `/api/v1/chats` | ids 数组或 delete_all |

**创建入参**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 助手名称 |
| icon | string | 否 | Base64 头像 |
| dataset_ids | list[string] | 否 | 关联知识库 ID 列表 |
| llm_id | string | 否 | 聊天模型，格式 `model_name@model_factory` |
| llm_setting | object | 否 | `temperature`(0.1)/`top_p`(0.3)/`presence_penalty`(0.4)/`frequency_penalty`(0.7) |
| prompt_config | object | 否 | `system`/`prologue`/`parameters`(含 knowledge 变量)/`empty_response`/`quote`/`tts`/`use_kg`/`reasoning`/`cross_languages`/`tavily_api_key`/`toc_enhance` |
| similarity_threshold | float | 否 | 0.2 |
| vector_similarity_weight | float | 否 | 0.3 |
| top_n | int | 否 | 6 |
| top_k | int | 否 | 1024 |
| rerank_id | string | 否 | 重排序模型 |

---

## 十、Session（会话）管理

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 创建 | POST | `/api/v1/chats/{chat_id}/sessions` | 创建 Chat 助手会话，入参 `name` + `user_id`(可选) |
| 列表 | GET | `/api/v1/chats/{chat_id}/sessions` | 支持 page/page_size/orderby/desc/name/id/user_id |
| 获取 | GET | `/api/v1/chats/{chat_id}/sessions/{session_id}` | 获取会话详情（含 messages/reference/avatar） |
| 更新 | PATCH | `/api/v1/chats/{chat_id}/sessions/{session_id}` | 重命名，入参 `name`（废弃 PUT） |
| 删除消息 | DELETE | `.../sessions/{session_id}/messages/{msg_id}` | 删除消息及其配对回复 |
| 消息反馈 | PUT | `.../messages/{msg_id}/feedback` | 入参 `thumbup`(boolean) + `feedback`(string,可选) |
| 批量删除 | DELETE | `/api/v1/chats/{chat_id}/sessions` | ids 数组或 delete_all |

---

## 十一、对话（Chat Completions）

### 与助手对话 — `POST /api/v1/chat/completions`

废弃: `POST /api/v1/chats/{chat_id}/completions`

**入参**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| messages 或 question | - | 是 | 二选一。messages 为 `[{role, content}]`，question 为字符串 |
| stream | boolean | 否 | 默认 true |
| chat_id | string | 否 | 助手 ID，不提供则用租户默认模型 |
| session_id | string | 否 | 会话 ID，不提供则自动创建 |
| llm_id | string | 否 | 可选模型覆盖 |
| pass_all_history_messages | boolean | 否 | 是否传全量历史消息覆盖存储的会话历史 |
| legacy | boolean | 否 | 兼容 v0.23 流式格式（累积输出+无 reasoning 标记） |

**出参（流式 SSE）**: 每行 `data:{"code":0,"data":{"answer":"...","reference":{},"id":"...","session_id":"...","final":false,...}}`，最后 `data:{"code":0,"data":true}`

### 与 Agent 对话 — `POST /api/v1/agents/chat/completions`

废弃: `POST /api/v1/agents/{agent_id}/completions`

**标准模式入参**: `agent_id`(必填) + `query`(必填) + `stream` + `session_id` + `inputs`(Begin 组件变量) + `files` + `user_id` + `return_trace` + `chat_template_kwargs`

**OpenAI 兼容模式**: 添加 `"openai-compatible": true`，用 `messages` 替代 `query`，响应合并 `model` 兼容字段。

**出参（流式 SSE 事件）**: `message`(内容) → `message_end`(含引用) → `node_finished`(组件结果+耗时) → `[DONE]`

### TTS 语音合成 — `POST /api/v1/chat/audio/speech`

**入参**: `text`(string, 必填)  
**出参**: `audio/mpeg` 二进制流

### ASR 语音识别 — `POST /api/v1/chat/audio/transcription`

**入参**: multipart `file`(wav/mp3/m4a/aac/flac/ogg/webm/opus/wma) + `stream`(boolean)  
**出参**: `{"code":0,"data":{"text":"..."}}`，流式模式为 SSE `partial` 事件

### 思维导图 — `POST /api/v1/chat/mindmap`

**入参**: `question` + `kb_ids` + `search_id`(可选)  
**出参**: `{"code":0,"data":{"name":"...","children":[...]}}`

### 相关问题推荐 — `POST /api/v1/chat/recommandation`

废弃: `POST /api/v1/sessions/related_questions`
**入参**: `question`(必填) + `search_id`(可选)  
**出参**: `{"code":0,"data":["问题1","问题2",...]}`（5-10个）

---

## 十二、Agent 管理

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 创建 | POST | `/api/v1/agents` | 入参 `title`(必填) + `description` + `dsl`(必填，Canvas DSL 对象) |
| 列表 | GET | `/api/v1/agents` | 支持 page/page_size/orderby/desc/title/id |
| 更新 | PUT | `/api/v1/agents/{agent_id}` | 可选更新 title/description/dsl |
| 删除 | DELETE | `/api/v1/agents/{agent_id}` | 删除 Agent |
| 版本列表 | GET | `/api/v1/agents/{agent_id}/versions` | 🆕 v0.26 |
| 版本详情 | GET | `/api/v1/agents/{agent_id}/versions/{version_id}` | 🆕 v0.26 |
| 上传文件 | POST | `/api/v1/agents/{agent_id}/upload` | 🆕 v0.26 |
| Canvas 上传 | POST | `/v1/canvas/upload/{agent_id}` | 上传文件到 Agent Canvas |
| 会话列表 | GET | `/api/v1/agents/{agent_id}/sessions` | 支持 page/page_size/id/user_id/dsl |
| 会话删除 | DELETE | `/api/v1/agents/{agent_id}/sessions` | ids 或 delete_all |
| 创建会话(废弃) | POST | `/api/v1/agents/{agent_id}/sessions` | 已废弃，对话时自动生成 session_id |

---

## 十三、Memory（记忆）管理 🆕

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 创建 | POST | `/api/v1/memories` | 入参: `name`(必填) + `memory_type`(必填, raw/semantic/episodic/procedural) + `embd_id` + `llm_id` |
| 列表 | GET | `/api/v1/memories` | 支持 tenant_id/memory_type/storage_type/keywords/page/page_size |
| 更新 | PUT | `/api/v1/memories/{memory_id}` | 可选: name/avatar/permission/llm_id/description/memory_size(默认5MB)/forgetting_policy(FIFO)/temperature/system_prompt/user_prompt |
| 配置 | GET | `/api/v1/memories/{memory_id}/config` | 获取完整配置 |
| 删除 | DELETE | `/api/v1/memories/{memory_id}` | 删除记忆 |
| 消息列表 | GET | `/api/v1/memories/{memory_id}` | 查询参数: agent_id/session_id(模糊)/page/page_size |
| 添加消息 | POST | `/api/v1/messages` | 入参: `memory_id`(list,必填) + `agent_id` + `session_id` + `user_id` + `user_input` + `agent_response` |
| 遗忘消息 | DELETE | `/api/v1/messages/{memory_id}:{message_id}` | 标注遗忘（优先被清理） |
| 消息状态 | PUT | `/api/v1/messages/{memory_id}:{message_id}` | 入参 `status`(boolean), 启用/禁用消息 |
| 搜索消息 | GET | `/api/v1/messages/search` | 入参: query(必填)/memory_id(必填)/agent_id/session_id/user_id/similarity_threshold(0.2)/keywords_similarity_weight(0.7)/top_n(10) |
| 最近消息 | GET | `/api/v1/messages` | 入参: memory_id(必填)/agent_id/session_id/limit(10) |
| 消息内容 | GET | `/api/v1/messages/{memory_id}:{message_id}/content` | 获取全文+嵌入向量 |

---

## 十四、文件管理

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 上传文件 | POST | `/api/v1/files` | multipart form `file=@path` + `parent_id`(可选)，创建文件夹时 JSON `{"name":"...","type":"folder"}` |
| 上传文档附件 | POST | `/api/v1/documents/upload` | `file`(form) 或 `?url=`(query)，二选一 |
| 下载附件 | GET | `/api/v1/agents/attachments/{id}/download` | `?ext=pdf/html/markdown/docx/xlsx/csv` |
| 列表文件 | GET | `/api/v1/files` | `?parent_id=&keywords=&page=&page_size=&orderby=&desc=` |
| 下载文件 | GET | `/api/v1/files/{file_id}` | 返回文件二进制流 |
| 移动/重命名 | POST | `/api/v1/files/move` | `src_file_ids`(必填) + `dest_file_id` + `new_name`（类似 Linux mv） |
| 删除 | DELETE | `/api/v1/files` | `ids`(必填) |
| 父目录 | GET | `/api/v1/files/{file_id}/parent` | 获取直接父目录 |
| 所有祖先 | GET | `/api/v1/files/{file_id}/ancestors` | 获取所有上级目录链 |
| 链接到数据集 | POST | `/api/v1/files/link-to-datasets` | `file_ids`(必填) + `kb_ids`(必填)，将文件转为文档并关联 |

---

## 十五、版本管理（Commits）

> 同样适用 `/api/v1/workspace/{id}/commits` 和 `/api/v1/datasets/{id}/commits`

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 创建提交 | POST | `/api/v1/folders/{id}/commits` | 入参 `message`(必填) + `files`(必填, list[{file_id, file_name, operation, content?}]) |
| 列表提交 | GET | `/api/v1/folders/{id}/commits` | page/page_size/order_by/desc |
| 获取提交 | GET | `.../commits/{commit_id}` | 含 file_count + files 变更列表 |
| 提交文件 | GET | `.../commits/{commit_id}/files` | 列出变更文件 |
| 提交内容 | GET | `.../commits/{commit_id}/files/{file_id}/content` | 获取提交时文件内容 |
| 提交树 | GET | `.../commits/{commit_id}/tree` | 完整文件树（含子目录嵌套） |
| Diff | GET | `.../commits/diff?from=&to=` | 对比两次提交差异 |
| 未提交变更 | GET | `/api/v1/folders/{id}/changes` | 类似 git status |
| 文件版本历史 | GET | `/api/v1/files/{file_id}/versions` | 文件在各提交中的变更历史 |

---

## 十六、Search App 管理

| 接口 | 方法 | 路径 | 作用 |
|------|------|------|------|
| 创建 | POST | `/api/v1/searches` | 入参 `name`(必填) + `description` |
| 列表 | GET | `/api/v1/searches` | keywords/page/page_size/orderby/desc/owner_ids |
| 获取 | GET | `/api/v1/searches/{search_id}` | 含 search_config |
| 更新 | PUT | `/api/v1/searches/{search_id}` | 入参 `name` + `search_config` |
| 删除 | DELETE | `/api/v1/searches/{search_id}` | 删除应用 |
| 搜索补全 | POST | `/api/v1/searches/{search_id}/completions` | 入参 `question`(必填) + `kb_ids`(可选)，SSE 流式返回 |

---

## 十七、系统

### 健康检查 — `GET /api/v1/system/healthz`

无需认证。废弃: `GET /v1/system/healthz`

**出参**: `{"db":"ok","redis":"ok","doc_engine":"ok","storage":"ok","status":"ok"}`。
异常时含 `_meta` 详情（`{"redis":{"elapsed":"5.2","error":"Lost connection!"}}`）。

---

## v0.24 → v0.26 废弃路径对照

| 废弃路径 | 替代路径 |
|----------|----------|
| `POST /v1/document/upload_info` | `POST /api/v1/documents/upload` |
| `POST /api/v1/file/upload` | `POST /api/v1/files` |
| `POST /api/v1/file/create` | `POST /api/v1/files` |
| `GET /api/v1/file/list` | `GET /api/v1/files` |
| `POST /api/v1/file/rm` | `DELETE /api/v1/files` |
| `POST /api/v1/file/rename` | `POST /api/v1/files/move` |
| `POST /api/v1/file/mv` | `POST /api/v1/files/move` |
| `POST /api/v1/file/convert` | `POST /api/v1/files/link-to-datasets` |
| `GET /api/v1/file/get/{id}` | `GET /api/v1/files/{file_id}` |
| `POST /api/v1/chats/{id}/completions` | `POST /api/v1/chat/completions` |
| `POST /api/v1/chats_openai/{id}/chat/completions` | `POST /api/v1/openai/{id}/chat/completions` |
| `PUT /api/v1/chats/{id}/sessions/{sid}` | `PATCH /api/v1/chats/{id}/sessions/{sid}` |
| `PUT .../chunks/{chunk_id}` | `PATCH .../chunks/{chunk_id}` |
| `GET /v1/system/healthz` | `GET /api/v1/system/healthz` |

---

## 错误码速查

| Code | 含义 |
|------|------|
| 0 | 成功 |
| 100 | Chunk 未找到 |
| 101 | 参数校验失败 |
| 102 | 业务逻辑错误（权限/不存在/重复/必填缺失等） |
| 103 | 无操作授权（非 owner） |
| 108 | 无数据集权限 |
| 109 | 无 Search App 授权 |
| 400 | 请求参数错误 |
| 401 | 未认证 |
| 403 | 禁止访问 |
| 404 | 资源未找到 |
| 409 | 同名冲突 |
| 500 | 服务器内部错误 |
