---
name: agent-sites-build
description: >-
  通过 Agent Sites 平台搭建、部署和维护 Web 应用（静态前端 + PocketBase 后端，或 Deno custom 全栈应用）。当用户提到"建站"、"搭建网站"、"做个网页/应用"、"部署到 Agent
  Sites"、"Agent Sites"、"建一个站点"、"上线一个页面"、"用 PocketBase 做后端"、"custom app"、"Deno 应用"、"agent-sites
  卡片"，或要求修改/更新/重新部署已有站点时，务必使用本 skill。也适用于询问 Agent Sites 平台能力边界（能建什么、不能建什么）的场景。
---

# Agent Sites 建站

通过 Agent Sites 平台搭建和部署 Web 应用：pocketbase 模式提供独立 PocketBase 后端与静态前端，custom 模式运行 Deno 应用。

## 触发条件

用户提出"建站 / 搭页面 / 做一个小应用 / 部署上线 / 更新已有站点 / 这个平台能建什么"时进入本 skill。核心流程：**先判断平台能力边界 → 确认需求 → 建 App → 配后端 → 写前端 → 部署 → 验证 → 输出站点卡片**。

## 前置：平台 API 参考

使用 `agent-platform-api` skill。按该 skill 实际安装目录解析以下参考文件（仓库内为 `.agents/skills/agent-platform-api/`，运行环境可能为 `.claude/skills/agent-platform-api/`）：

- `references/agent-sites.md` — 完整 API 文档、数据结构、约束
- `references/html-guide.md` — 前端设计规范、色彩排版、动效、常用模式
- `references/card-tag.md` — `<agent-sites>` 卡片标签格式规则

先读 API 文档；编写前端前读设计指南，输出卡片前读标签规则。

### 环境变量

系统自动注入以下变量，分权自检依赖它们：

- `$AGENT_CONFIG_ID` — 当前智能体的配置 ID（UUID）
- `$ENVIRONMENT_ID` — 当前智能体所在的 environment ID

> **重要**：`$AGENT_CONFIG_ID` 用于开发/业务分权自检。site 详情中的 `createdByAgentConfigId` 与之对比，判断当前智能体是否有权修改 site 文件。

API 使用 `$USER_META_BASE_URL` 与 `$USER_META_API_KEY`。创建或修改站点前检查身份变量；缺失时停止并报告运行时配置问题，不猜测 ID，也不省略创建者。未绑定配置的 environment 中 `AGENT_CONFIG_ID` 为空。

```bash
: "${USER_META_BASE_URL:?缺少平台地址}" "${USER_META_API_KEY:?缺少平台凭证}"
BASE="$USER_META_BASE_URL/web/agent-sites"
```

## 工作流程

### 1. 理解需求与平台约束

**首先理解平台能力边界**，再和用户确认需求。Agent Sites 平台**仅支持以下两种部署模式**：

| ✅ 支持 | ❌ 不支持 |
|---------|----------|
| 静态前端（HTML/CSS/JS）+ PocketBase 后端 | Python（FastAPI/Flask/Django） |
| Deno 全栈应用（custom 模式） | Flutter / React Native 原生 App |
| | Docker 容器 |
| | Node.js / Express / Koa |
| | Java / Go / Rust / PHP 后端 |
| | 需要在服务器上跑 `pip install` / `npm install` 的东西 |
| | 任何需要操作系统级依赖的东西 |

**原则**：当用户提出需求时，先判断目标方案是否在平台能力范围内——

- 如果平台不支持（如用户说"做个 Python 后端"），**立即告知用户平台约束**，并给出平台支持的替代方案（如"用 PocketBase collection 替代 Python CRUD，前端用 JS 完成业务逻辑"）
- **不要说"我先用 Python 写一个"再等用户纠正**——直接跳到平台能支持的方案

然后和用户确认：站点用途、需要什么数据、前端风格偏好。**可见性无需主动询问——用户未指定时一律使用 `private`**（仅创建者可见），用户明确要求公开/组织可见时再按需调整。

### 2. 创建 App

`POST /web/agent-sites/apps`，**同时**记录返回的 `id`（RCS 内部 UUID，后续 L1/L2 API 都用它）和 `remoteAppId`（形如 `app-xxxx`，业务前端访问用它）。body 中必须传入 `"agentConfigId"` 为 `$AGENT_CONFIG_ID` 的值，以便记录此 site 的创建者。

```bash
: "${AGENT_CONFIG_ID:?缺少当前 Agent 配置 ID}" "${ENVIRONMENT_ID:?缺少当前环境 ID}"
RESP=$(jq -n --arg agentConfigId "$AGENT_CONFIG_ID" \
  '{name:"my-app",visibility:"private",agentConfigId:$agentConfigId}' | \
  curl --fail-with-body -sS -X POST "$BASE/apps" \
    -H "Authorization: Bearer $USER_META_API_KEY" \
    -H "Content-Type: application/json" --data-binary @-) || exit 1
APP_ID=$(printf '%s' "$RESP" | jq -er 'select(.success == true) | .data.id | strings | select(length > 0)') || exit 1
REMOTE_APP_ID=$(printf '%s' "$RESP" | jq -er 'select(.success == true) | .data.remoteAppId | strings | select(length > 0)') || exit 1
```

### 2.5 分权自检（修改已有 site 时）

如果当前 site 已存在（非首次创建），在执行任何写入操作前必须自检，并从详情响应保存 `remoteAppId` 到 `REMOTE_APP_ID`，供后续验证和卡片使用：

```bash
: "${AGENT_CONFIG_ID:?缺少当前 Agent 配置 ID}" "${ENVIRONMENT_ID:?缺少当前环境 ID}"
SITE_RESP=$(curl --fail-with-body -sS "$BASE/apps/$APP_ID" \
  -H "Authorization: Bearer $USER_META_API_KEY") || exit 1
REMOTE_APP_ID=$(printf '%s' "$SITE_RESP" | jq -er 'select(.success == true) | .data.remoteAppId | strings | select(length > 0)') || exit 1
CREATOR=$(printf '%s' "$SITE_RESP" | jq -er '
  if .success == true and (.data | type == "object" and has("createdByAgentConfigId")) then
    .data.createdByAgentConfigId |
    if . == null then "null"
    elif type == "string" and length > 0 then .
    else error("无效的创建者字段") end
  else error("站点详情不完整或请求失败") end') || exit 1

if [ "$CREATOR" != "null" ] && [ "$CREATOR" != "$AGENT_CONFIG_ID" ]; then
  echo ""
  echo "⚠️ 此 site (${APP_ID}) 由其他智能体创建。"
  echo "我作为业务智能体，可以操作 PocketBase 数据（CRUD），"
  echo "但无权修改站点文件。"
  echo ""
  echo "要修改站点代码，请在右侧 Sites 面板点击「溯源」按钮，"
  echo "回到创建此 site 的智能体继续操作。"
  exit 1
fi
```

> **注意**：成功响应中显式的 `createdByAgentConfigId: null` 表示没有创建者记录（未记录或已删除），自检不再限制 Agent 身份；平台的用户、组织与资源授权仍然生效。HTTP 失败、无效 JSON、字段缺失或身份变量缺失均应停止写入。此自检是 Agent 操作约束，不是服务端安全边界。

#### 自查时机

以下操作前必须执行分权自检：

| 操作 | 必须自检 |
|------|---------|
| 上传静态文件 | ✅ |
| 批量上传 tar.gz | ✅ |
| 部署 custom app | ✅ |
| 修改 site 配置 (PATCH) | ✅ |
| 删除 site | ✅ |
| 重签 token | ✅ |
| 操作 PB 数据 (L2 API) | ❌ 不限制 |
| 查看 site 详情/列表 | ❌ 不限制 |

### 3. 配置后端

通过 L2 API 创建 PocketBase collection。字段定义要带 `"id"`，rules 控制权限。平台在创建 App 时已主动验证 superuser 凭证，正常情况下创建后可立即操作 records。

### 4. 编写前端

Write 工具创建文件（不用 shell 重定向）。每个独立项目先在当前目录 `mkdir <name>` 再编写。**禁止放 `/tmp`**——系统临时目录不可靠，文件可能丢失。

编写代码前先读 `references/html-guide.md`——每个站点都要重新构思设计方向（调性、色彩、布局），不要复用上一个站的方案。

### 5. 上传部署

单文件 PUT、批量 tar.gz POST（详见 `agent-sites.md`）。

### 6. 验证

平台不提供已部署文件的枚举接口。上传后按本地部署文件清单，直接访问已知入口和资源 URL；pocketbase 模式检查 `index.html` 与所引用的 JS/CSS，custom 模式检查入口页面与实际业务路由。请求携带平台凭证，以支持默认的 private 站点：

```bash
# 验证单个文件
curl --fail-with-body -sS -o /dev/null -w "HTTP=%{http_code}\n" \
  "$USER_META_BASE_URL/$REMOTE_APP_ID/index.html" \
  -H "Authorization: Bearer $USER_META_API_KEY" || exit 1
```

确认响应为 HTTP 200，并检查页面内容与关键交互、数据读写。3xx 登录跳转、登录页或 SPA 兜底 HTML 都不代表目标资源验证通过；不要用自动跟随重定向掩盖鉴权失败。

`$USER_META_BASE_URL` 仅用于 Agent 内部验证，可能是用户浏览器不可达的内部地址。面向用户的访问入口统一使用站点卡片或 Sites tab，不手工拼接内部 URL。

### 7. 站点卡片

**已获取本次任务相关站点的真实 `remoteAppId` 时必做。** 回复末尾单独一行输出标签，`agent-site-id` 使用创建或详情响应中的 `remoteAppId`，由前端解析用户可访问的地址：

```
<agent-sites agent-site-id="app-xxxx"/>
```

格式规则见 `references/card-tag.md`，**不要在标签前后加文字说明或引导语**（卡片自带 iframe 预览 + 按钮）。

没有可关联站点时（如仅咨询平台能力，或创建因身份缺失等原因中止），不输出卡片，不使用占位 ID。

## 备选工作流：Custom App（type=custom）

适用全栈 Deno 应用。**先读 `references/agent-sites.md` 的「Custom App 部署」章节再开工**——custom 模式与经典 pocketbase 模式工作流差异很大。

当前 RCS 创建接口仅支持 `pocketbase` 和 `custom` 两种类型，不支持为 custom 启用托管 PocketBase；不要传 `enable_pb` 或依赖 `PB_*` 环境变量。需要托管 CRUD 时选 pocketbase；必须使用自定义路由时选 custom 并实现自身的数据层。

精简流程：

1. **理解需求**：确认确实需要 custom（如自定义路由、复杂业务逻辑、SQLite、WebSocket）；否则优先 pocketbase 模式
2. **创建 App**：沿用步骤 2 的身份检查、创建者字段与响应校验，body 加 `"type":"custom"`，默认 `"visibility":"private"`
3. **写 main.ts**：用 `PORT` 环境变量 + `127.0.0.1` 绑定；不要依赖父进程环境变量（被 `clearEnv` 隔离）
4. **打包 tar.gz**：根目录必须有 `main.ts` 或 `main.js`
5. **部署**：`POST /web/agent-sites/apps/:id/deploy --data-binary @app.tar.gz`
6. **验证**：按步骤 6 带鉴权请求页面和业务路由，确认状态码、内容与关键交互
7. **站点卡片**：同经典模式

### 关键差异（vs pocketbase 模式）

| 维度 | pocketbase 模式 | custom 模式 |
|------|----------------|-------------|
| 创建参数 | 默认 | 必须加 `type:"custom"` |
| 后端 | 平台自动起 PocketBase | 自己在 main.ts 里实现 |
| L2 PB API | `/apps/:id/api/*` 可用 | 返 400（custom 无 PB） |
| 部署 | `PUT /apps/:id/files/:path` 上传静态前端 | `POST /apps/:id/deploy` 上传 gzip tar.gz |
| 业务前端访问 | `$USER_META_BASE_URL/{remoteAppId}/` | 相同（走 RCS proxy + visibility） |
| 后端日志 | PB 进程日志 | 子进程 stdout/stderr **被丢弃**，需自己写日志文件 |

## 常见陷阱

### 1. 不要用文件系统做 CRUD 存储

custom app 的 Deno 进程中，`--allow-write` 权限仅限 `<runtimeDir>`（`data/app-{id}/runtime/`）。代码目录 `deploy-{a|b}/` 每次部署整体替换，写入的数据会被清空。

**错误做法**：自己写 JSON 文件实现增删改查——权限问题搞不定、跨部署丢数据、并发不安全。
**正确做法**：需要 CRUD 数据层时，**直接用 pocketbase 模式**（默认），平台自动起 PocketBase 实例，前端通过 `/api/collections/:name/records` 直接操作，L2 API 透传提供 superuser 全权操作。标准 CRUD 没有理由绕到 custom。

### 2. 权限问题不要死磕

custom app 的 Deno 进程只有最窄权限：`--allow-net` + `--allow-read=<codeDir>` + `--allow-read=<runtimeDir>` + `--allow-write=<runtimeDir>`。环境变量也严格隔离（`clearEnv: true`）。

如果你在权限问题上反复尝试超过 2 轮还解决不了——**这条路不通，立刻换方案**。大概率你的场景根本不需要 custom 模式，pocketbase 模式就够用了。

### 3. Custom app 没有托管 PocketBase

custom 类型没有托管 PB 实例，L2 PB API（`/web/agent-sites/apps/:id/api/*`）对它返 400。不要把 pocketbase 模式的 collection/records 接口用于 custom。

### 4. 选型决策：什么时候用 custom

只有以下场景才值得用 custom 模式（其他情况一律 pocketbase）：

| ✅ 用 custom | ❌ 不用 custom |
|-------------|---------------|
| 需要 Deno 自定义路由逻辑 | 只是静态前端 + CRUD 后端 |
| 需要 WebSocket / SSE 长连接 | 想存点数据（有 PB collections） |
| 需要 SQLite 本地数据库 | 想用 fetch shim（pocketbase 模式自带） |
| 前后端打包在一个 Deno 进程 | 想省事（pocketbase 模式更简单） |

> 碰不准时默认选 pocketbase；需要自定义路由时再选择 custom。

### 5. 文件路径：禁止 `/tmp`，项目自建文件夹

- **禁止放 `/tmp`**：`/tmp` 是系统临时目录，Bun/Deno 进程间不可见，其他 agent 或进程可能随时清理，文件会丢失
- **每个独立项目先在当前目录 `mkdir <name>`**，再在里面用 Write 工具创建文件。不要直接在 pwd 下散放文件，也不要放在系统目录
- 临时文件放当前 `./user/` 子目录下
- Write 工具创建文件，**不用 shell 重定向**（`echo > file`、`cat > file` 等），shell 重定向可能导致内容截断或编码问题

### 6. Shell 命令行安全

- **不要用变量存整个 header 字符串**：`AUTH="-H 'Authorization: ...'"` 这种嵌套引号在 bash 中不会正确展开，导致 401 Unauthorized。header 值直接写在 `-H` 后面
- **变量保存纯值或参数数组**：纯值在 `-H "Authorization: Bearer $TOKEN"` 中引用；多组 headers 可用 Bash 数组 `AUTH=(-H "Authorization: Bearer $USER_META_API_KEY")`，调用时以 `"${AUTH[@]}"` 展开
- **复杂 JSON body 不要内联转义**：用 Write 工具先写文件，再 `curl --data @file.json`，避免手写转义导致的格式错误

### 7. 内联脚本必须先验证

- 任何 `python3 -c "..."` 或内联 shell 脚本，执行前手动检查语法正确性
- 复杂脚本不要内联——用 Write 工具写成独立文件再执行，降低引号/缩进/转义出错的概率
- 脚本执行后不只检查返回值，还要验证输出结果是否符合预期。**PATCH 返回 OK 不代表字段真的写进去了**——应再 GET 一次确认

### 8. 最小交付原则

- 按用户当前需求交付核心 MVP，额外代码可以提一句但**不写完整文件**
- 先完成核心功能并验证通过（数据读写、页面展示、部署上线），再问用户是否需要扩展
- 用户说"做个记账应用"，先交付最简版本：能添加记录、显示列表。不要一上来就做分类筛选、月度报表、导出 CSV

### 9. 分权自检必须最先执行

在修改已有 site 的任何文件或配置前，**必须**先执行分权自检（见步骤 2.5）。跳过自检直接操作文件，会导致业务智能体覆盖开发智能体的代码。

**错误做法**：不检查 `createdByAgentConfigId` 就直接 PUT 文件。
**正确做法**：先 `GET /web/agent-sites/apps/$APP_ID`，对比 `$AGENT_CONFIG_ID`，不匹配时立即终止并引导用户溯源。

## 输出规范

- **中间过程**：如实报告创建结果（`id` 与 `remoteAppId`）、部署方式、验证的 HTTP 状态码
- **访问入口**：通过站点卡片或 Sites tab 提供，不展示内部 `$USER_META_BASE_URL` 或包含占位符的 URL
- **结尾**：有本次任务相关站点的真实 `remoteAppId` 时，回复最末尾单独一行输出卡片标签，前后不加任何文字；无可关联站点时省略卡片
