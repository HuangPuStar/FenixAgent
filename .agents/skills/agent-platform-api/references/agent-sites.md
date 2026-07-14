# Agent Sites 部署

Agent Sites 是一个轻量级建站平台，每个 App = 独立 PocketBase 后端 + 前端静态目录。部署操作统一走 RCS 代理 API（RCS 后端持有 master key 和 platform token，agent 无需接触凭证）。

## 前置

以下环境变量由系统自动注入（同其他 RCS API）：

- `$USER_META_BASE_URL` — RCS API 地址
- `$USER_META_API_KEY` — Bearer token
- `$USER_META_ORG_ID` — 当前组织 ID（后端自动隔离）

```bash
BASE="$USER_META_BASE_URL/web/agent-sites"
AUTH="-H 'Authorization: Bearer $USER_META_API_KEY' -H 'Content-Type: application/json'"
```

## Quick Start

按顺序四步。第 1 步返回 `remoteAppId`（形如 `app-abcd1234`），后续部署步骤通过 `id`（RCS 内部 ID）操作。

### 1. 创建 App

自动在 agent-sites 平台创建远程 App + 申请 platform token + 写入 RCS DB。

```bash
RESP=$(curl -s -X POST $BASE/apps $AUTH \
  -d "{\"name\":\"my-app\",\"visibility\":\"private\",\"agentConfigId\":\"$AGENT_CONFIG_ID\"}")
APP_ID=$(echo "$RESP" | jq -r '.data.id')
REMOTE_APP_ID=$(echo "$RESP" | jq -r '.data.remoteAppId')
echo "APP_ID=$APP_ID"
echo "REMOTE_APP_ID=$REMOTE_APP_ID"   # 形如 app-abcd1234
```

- `name` 只允许 `[a-z0-9-]`、长度 1..32；中文/大写/空格/下划线会被 400 拒绝
- `visibility`：`private`（仅创建者）/ `org`（组织内）/ `authenticated`（已登录）/ `public`（公开）。默认 `private`。**agent 硬性规则：用户未明确要求公开/组织可见时，必须传 `"private"`，不得省略 visibility 字段，不得擅自改为 public。**
- `type`：`pocketbase`（默认，经典模式）/ `custom`（自定义应用）。custom 类型可选 `"enable_pb": true` 同时启动托管的 PocketBase 实例（详见 Custom App 章节）
- **`agentConfigId`**（string，可选）：创建此 site 的 agent config id。**agent 创建时一律从 `$AGENT_CONFIG_ID` 环境变量读取并传入**，用于后续分权校验。不传则 `createdByAgentConfigId` 为 `null`，表示无创建者——所有绑定 agent 均可自由操作文件（但缺少溯源能力）。
- RCS 后端自持 platform token，不暴露给用户

> **AgentSiteApp 响应字段**：`id`（RCS 内部 UUID，后续所有 L1/L2 API 都用它）/ `remoteAppId`（agent-sites 远程 id，形如 `app-xxxxxxxx`，业务前端访问用它）/ `organizationId` / `userId` / `name` / `description`（可为 `null`）/ `visibility` / `appType`（`pocketbase` | `custom`，默认 pocketbase）/ `entryFile`（custom 部署后写入入口文件名，否则 `null`）/ `activeSlot`（当前激活槽位 `a` | `b`，否则 `null`）/ `deployedAt`（最后部署时间秒级时间戳，否则 `null`）/ `createdByAgentConfigId`（创建此 site 的 agent config UUID，可能为 `null` 表示创建者已删除，此时所有绑定 agent 均可操作）/ `createdAt` / `updatedAt`（秒级时间戳）。**务必同时存下 `id` 和 `remoteAppId`**——L1/L2 API（`/web/agent-sites/apps/{id}/...`）只认 RCS UUID，前端访问（`$USER_META_BASE_URL/{remoteAppId}/`）只认 remoteAppId。

### 2. 配后端 collection

通过 RCS L2 API 透传到 PocketBase。RCS 后端自动注入 platform token（superuser 权限，绕过所有 rules）。

```bash
L2="$BASE/apps/$APP_ID/api"

curl -s -X POST $L2/collections $AUTH \
  -d '{
    "name":"messages","type":"base",
    "fields":[
      {"id":"text1001","name":"author","type":"text","required":true,"min":1,"max":50,"system":false,"hidden":false,"presentable":false,"pattern":"","autogeneratePattern":""},
      {"id":"text1002","name":"body","type":"text","required":true,"min":1,"max":500,"system":false,"hidden":false,"presentable":false,"pattern":"","autogeneratePattern":""}
    ],
    "listRule":"","viewRule":"","createRule":"","updateRule":null,"deleteRule":null
  }' | jq '.name'   # → "messages"
```

**字段必须带 `"id"`**——省略 id 创建虽不报错，但会让 collection 多出名为 `id` 的多余 text 字段，污染 schema。

**rules 三态**（PocketBase 0.23 语义，与 0.22 完全相反）：
- `""`（空串）= 允许匿名访问
- `null` = 拒绝（仅 superuser / token 绕过）
- 表达式（如 `"@request.auth.id != ''"`）= 条件放行

> agent-sites 平台在 createApp 返回前已主动 `auth-with-password` 验证 superuser 凭证（重试 3 次、每次间隔 500ms），消除"凭证异步落盘"竞态。极少数情况下验证超时但 PocketBase 进程已启动——首次代理仍可能返 503 `PB_UNAVAILABLE`，等 1-2 秒重试同一请求即可，不要重建 app。

### 3. 上传前端文件

**单文件上传**（PUT，≤ 1 MiB）：

```bash
curl -s -X PUT $BASE/apps/$APP_ID/files/index.html $AUTH \
  --data-binary @index.html | jq '.data.path'
```

**批量上传**（gzip tar，压缩前 ≤ 10 MiB / 解压 ≤ 50 MiB / 单文件 ≤ 5 MiB / ≤ 200 条目）：

```bash
tar czf site.tar.gz -C ./dist .
curl -s -X POST $BASE/apps/$APP_ID/files/bundle $AUTH \
  --data-binary @site.tar.gz | jq '.data.total_files'
```

后缀白名单：html/htm/css/js/json/svg/png/jpg/jpeg/webp/ico/txt/map。

上传用 `--data-binary`，不是 `-F`（multipart）。

### 4. 访问验证

站点上线后通过 chat 右侧 **Sites** tab 或卡片「查看站点」按钮预览，不需要手工拼 URL。

> **告知用户时引导操作卡片或 Sites tab，禁止直接贴 `$USER_META_BASE_URL` 拼接的地址。**`$USER_META_BASE_URL` 是服务器内部地址，外部用户无法访问。

- `visibility=public` → 任何人可访问
- `visibility=org` → 同组织成员可访问
- `visibility=private` → 仅创建者可访问
- `visibility=authenticated` → 任何已登录 RCS 用户可访问

## 完成后引导用户在 chat UI 查看

agent 完成站点部署/更新后，用户最直接的预览路径是 chat 右侧的 **Sites** tab，而不是手工拼 URL。在最终回复里简短提示一句，能省去用户翻文档的负担。

**UI 路径速查**：

| 入口 | 位置 | 作用 |
|------|------|------|
| Sites tab | chat 右侧顶部一级 tab（Files / **Sites**） | 切换到站点预览区 |
| **+** 按钮 | Sites 二级 tab 栏末尾 | 弹出挂载对话框，多选**当前未绑定**的站点 |
| **×** 按钮 | 单个 site tab 右侧（hover 显示，激活 tab 常驻） | 卸载该 site，带 confirm 弹层 |

**引导话术示例**（按场景选一句，用用户的语言）：

- 首次部署新 App：「站点已部署。点击下方卡片的 **查看站点** 按钮直接预览。」
- 更新已上线前端：「前端已更新，已挂载的 site tab 会自动刷新。」
- 配置后端 collection 后：「后端就绪，在右侧 Sites tab 打开对应站点即可联调。」

> 挂载/卸载立即生效，**不需要重启 agent 实例**——绑定关系只由 RCS DB 维护，agent 运行时不消费。重复挂载走 PK 联合唯一 + `ON CONFLICT DO NOTHING`，幂等无副作用。

## 前端开发

**编写前端代码前，必须先 `cat` 读取 `references/html-guide.md`**——该指南涵盖设计方向、色彩排版、动效背景等完整设计规范，以及数据渲染、XSS 防护、搜索过滤等常用模式。

### fetch 自动重写

浏览器 GET HTML 时 agent-sites 平台会注入 shim，把 `fetch('/api/x')` 自动重写成 `fetch('/{app_id}/api/x')`。前端绝对路径 `/api/...` 直接用。

fetch 以外的路径（`<a href>`、`<img src>`、`<link href>`、`axios`、`XMLHttpRequest`）不被 shim 覆盖，写成相对路径（`./api/x` 或 `api/x`）。

### 禁止路径

- **`/{remoteAppId}/_/`**（PocketBase Admin UI）被 agent-sites 平台显式拦截，返回 404 + `"Admin UI 不开放，请用 platform token + API"`。**只能通过 L2 API（`/web/agent-sites/apps/{id}/api/*`）操作 collections**，不能用浏览器登录 Admin。
- 业务前端访问其他 `_/` 开头的子路径同样会被拦截。

### 前后端联动示例（留言板）

把 collection 的 `listRule`/`viewRule`/`createRule` 设成 `""` = 允许匿名访问。

最小留言板 `index.html`：

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>留言板</title></head>
<body>
  <h1>留言板</h1>
  <form id="f">
    <input name="author" placeholder="名字" required>
    <input name="body" placeholder="说点什么" required>
    <button>发送</button>
  </form>
  <ul id="list"></ul>
  <script>
    const API = '/api/collections/messages/records';
    async function load() {
      const { items } = await (await fetch(API)).json();
      list.innerHTML = items
        .map(m => `<li><b>${m.author}</b>: ${m.body}</li>`).join('');
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: fd.get('author'), body: fd.get('body') })
      });
      f.reset();
      load();
    };
    load();
  </script>
</body>
</html>
```

### 更新已上线的前端

PUT 同路径直接覆盖（幂等）。编辑一律用 Read/Edit/Write 工具。

- 本地有副本：Read → Edit → 重新 PUT 上传
- 本地没有副本：先 GET 线上内容作参考 → Write 落盘 → **删掉平台注入的 fetch shim**（`<script>(function(){var PREFIX=` 开头那段）→ Edit → PUT 上传

> GET 线上 HTML 返回的是平台已注入 fetch shim 的版本。整段存盘再 PUT 回去会让 shim 块逐次累积（HTML 膨胀）。从首次上传起就保留本地原始副本。

查看当前线上内容：

```bash
curl -s $USER_META_BASE_URL/$REMOTE_APP_ID/index.html
```

## App 管理

### 查看列表

```bash
curl -s $BASE/apps $AUTH | jq '.data[] | { id, name, remoteAppId, visibility }'
```

### 查看详情

```bash
# 按 RCS 内部 UUID
curl -s $BASE/apps/$APP_ID $AUTH | jq '.data'

# 按 remoteAppId（app-xxxxxxxx）
curl -s $BASE/apps/by-remote/$REMOTE_APP_ID $AUTH | jq '.data'
```

### 更新 App（PATCH）

可改 `name` / `description` / `visibility`。owner/admin 才有权限。

```bash
curl -s -X PATCH $BASE/apps/$APP_ID $AUTH \
  -d '{"description":"新描述","visibility":"org"}' | jq '.data'
```

### 重签 Token

吊销旧 token + 申请新 token + 更新 DB。owner/admin 才有权限。

```bash
curl -s -X POST $BASE/apps/$APP_ID/rotate-token $AUTH
```

> 重签后旧 platform token 立即失效。RCS 后端自持 token，agent 无需关心，但如果业务前端直接用了 token（不推荐），需要重新获取。

### 删除 App

真删：停远端 PB + 删数据 + 删前端 + 吊销所有 token + RCS DB 硬删 row，不可恢复。owner/admin 才有权限。

```bash
curl -s -X DELETE $BASE/apps/$APP_ID $AUTH
```

> ⚠️ **L2 PB 透传不受 visibility 限制**：上面所有 L1 App 管理 API（PATCH/DELETE/rotate-token/upload）都要求 owner/admin 权限，但 **L2 PB 透传 `/apps/:id/api/*` 任何 org 成员可调**——只要在同一个组织内，普通成员也能用 platform token（superuser 权限）操作 private app 的 PocketBase 数据。`visibility` 只控制**业务前端访问**（浏览器 GET 站点），与 L2 API 调用无关。如果 app 内有敏感数据，注意组织内成员的访问边界。

## 用 token 直接操作数据（CRUD）

agent 通过 L2 API 操作 PocketBase records（后端自动注入 platform token = superuser 权限，绕过所有 rules）。

```bash
L2="$BASE/apps/$APP_ID/api/collections/messages/records"

# 查列表（PB 原生格式：.items 数组、.totalItems 总数）
curl -s $L2 $AUTH | jq '.items'

# 新增
curl -s -X POST $L2 $AUTH \
  -d '{"author":"bot","body":"自动初始化数据"}'

# 修改（PATCH 指定 record id）
curl -s -X PATCH $L2/$RECORD_ID $AUTH \
  -d '{"body":"改过的内容"}'

# 删除（返回 204，无 body）
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE $L2/$RECORD_ID $AUTH
```

> L2 透传的是 PB 原生响应（envelope），取值用 `jq '.id'` / `jq '.items'`，不是平台壳的 `jq '.data.xxx'`。

## 凭证总结

| 要做什么 | 用什么 |
|----------|--------|
| 创建/列表/删除 App、上传文件 | `$AUTH`（RCS API Key）→ RCS 后端用 master key |
| 创建/修改后端 collection、records | `$AUTH`（RCS API Key）→ RCS 后端注入 platform token |
| 业务前端公开访问后端 | 不带凭证，交给 collection 的 rules |

**agent 永远不需要直接接触 `AGENT_SITES_MASTER_KEY` 或 platform token**——这些由 RCS 后端管理。

## 前端开发注意点

### 中文输入法 Enter 提交问题

监听 `keydown` 提交表单时，中文输入法（IME）的"确认选词"也会触发 Enter 键事件，导致在 composition 未完成时误提交。必须加 `e.isComposing` 判断：

```javascript
// ❌ 中文输入法按 Enter 选词时会误触
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') submit();
});

// ✅ 跳过 composition 阶段的 Enter
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) submit();
});
```

## Custom App 部署（type=custom）

适用于全栈 Deno 应用：前端 + 后端打包成 gzip tar.gz 上传，平台 spawn `deno run` 子进程全量代理 HTTP 流量。**不走 PocketBase**——你的 `main.ts` 自己处理路由、数据库、鉴权。

### 何时选 custom

| 场景 | 选 pocketbase | 选 custom |
|------|---------------|-----------|
| 静态前端 + 简单 CRUD 后端 | ✅ | ❌ |
| 需要自定义路由、复杂业务逻辑 | ❌ | ✅ |
| 全栈 Deno 应用（前后端在一起） | ❌ | ✅ |
| 需要 SQLite / WebSocket / 长连接 | ❌ | ✅ |

### 1. 创建 custom app

```bash
RESP=$(curl -s -X POST $BASE/apps $AUTH \
  -d "{\"name\":\"my-deno-app\",\"type\":\"custom\",\"visibility\":\"private\",\"agentConfigId\":\"$AGENT_CONFIG_ID\"}")
APP_ID=$(echo "$RESP" | jq -r '.data.id')
REMOTE_APP_ID=$(echo "$RESP" | jq -r '.data.remoteAppId')
```

注意：
- `type:"custom"` 必填——不传默认 `pocketbase`
- 创建后 `port=0`、`entryFile=null`、`activeSlot=null`、`deployedAt=null`——此时访问 `/{remoteAppId}/` 会返 503，**必须先 deploy**

### 2. 写 main.ts

平台 spawn 的进程等效于：

```bash
# 无 PocketBase（默认）
deno run --allow-net --allow-env=PORT \
  --allow-read=<codeDir> --allow-read=<runtimeDir> \
  --allow-write=<runtimeDir> main.ts

# 有 PocketBase（enable_pb: true 时额外透传 PB 相关变量）
deno run --allow-net --allow-env=PORT,PB_URL,PB_SUPERUSER_EMAIL,PB_SUPERUSER_PASSWORD \
  --allow-read=<codeDir> --allow-read=<runtimeDir> \
  --allow-write=<runtimeDir> main.ts
```

**关键约束**：

- **必须用 `PORT` 环境变量绑定端口，绑定 `127.0.0.1`**（不是 `0.0.0.0`，不是固定 `8080`）
- **环境变量隔离**：spawn 时 `clearEnv: true` + 白名单只透传 `PATH` / `HOME` / `LANG` / `TZ` + 注入 `PORT`。父进程敏感凭证（master key 等）**不透传**。custom app 拿不到 `AGENT_SITES_MASTER_KEY`、`DATABASE_URL` 等服务器环境变量。需要外部配置请打包进 gzip 包内或写进 `runtime/` 目录的配置文件。
- **stdout / stderr 被丢弃**：`console.log` / `console.error` 输出平台日志看不到，需要日志就写进 `runtime/` 目录的文件
- **路径用 `endsWith` 匹配**：代理透传完整 pathname（含 `/{remoteAppId}` 前缀），`url.pathname === "/api/x"` 匹配不上，改用 `url.pathname.endsWith("/api/x")`
- **`X-Forwarded-Prefix` header**：平台注入 `X-Forwarded-Prefix: /{appId}` header，如果需要在后端拼绝对 URL，可以读取 `req.headers.get("x-forwarded-prefix") || ""`
- **前端 fetch 用相对路径，无 shim**：custom 模式没有 fetch 注入，`fetch("./api/x")` 靠浏览器自动补全，`fetch("/api/x")` 会 404
- **请求体上限 50 MiB**：RCS 代理 + agent-sites 平台代理都限 50 MiB body

最小 main.ts：

```typescript
const port = parseInt(Deno.env.get("PORT") || "8080");

Deno.serve({ hostname: "127.0.0.1", port }, (req) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/api/hello")) {
    return Response.json({ message: "hello" });
  }

  return new Response(`<!doctype html>
<html><body><h1>It works</h1></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
```

### 3. 打包 + 部署

包内根目录必须有 `main.ts`（优先）或 `main.js`：

```bash
tar czf app.tar.gz -C ./your-app-dir .
```

**限制**：压缩后 20 MiB / 解压后 100 MiB / 单文件 10 MiB / 条目数 500。
**允许后缀**：`.html .htm .css .js .json .svg .png .jpg .jpeg .webp .ico .txt .map .ts .mjs .mts .jsx .tsx .wasm .sql .db .sqlite .sqlite3`

部署：

```bash
RESP=$(curl -s -X POST $BASE/apps/$APP_ID/deploy $AUTH \
  --data-binary @app.tar.gz)
echo "$RESP" | jq '.data'
# {
#   "files": 3,
#   "totalBytes": 1024,
#   "entryFile": "main.ts",
#   "slot": "a",
#   "deployedAt": 1719792000
# }
```

注意：
- 用 `--data-binary`（不能 `-F` multipart）
- `Content-Type` 不用设——平台靠 gzip magic bytes（`1f 8b`）识别
- **仅 custom 类型可部署**：pocketbase 类型调这个接口返 400 `"App {remoteAppId} 不是 custom 类型，无法部署"`

### 4. 验证

```bash
# 前端
curl -s $USER_META_BASE_URL/$REMOTE_APP_ID/

# 后端 API
curl -s $USER_META_BASE_URL/$REMOTE_APP_ID/api/hello
```

业务前端访问走 RCS proxy，按 visibility 校验（与 pocketbase app 一致）。

### 5. 更新（双槽位热切换）

改完代码 → 重新打包 → 再次 `POST /apps/:id/deploy`。平台自动：

- 解压到另一个槽位（a↔b）
- 新端口 spawn 新进程
- TCP 探活（轮询 `127.0.0.1:{port}`，**10 秒超时**，每 200ms 一次）
- 原子切换路由（store 更新 `active_slot`）
- 停旧进程

零 downtime——旧进程处理完存量请求才被杀。重新部署后 `slot` 会变化（a→b 或 b→a）。

### 6. 故障排查

**部署返 500** + `INTERNAL_ERROR`，message sanitize 为 `"服务器内部错误"`——平台日志能看到原始 `"自定义应用健康检查失败 app_id=... port=..."`。原因：
- main.ts 同步代码抛错（TypeScript 类型错误 / 缺少 import 文件）
- `Deno.serve` 没绑定 `127.0.0.1` 或没用 `PORT` 环境变量
- 启动时间超过 10 秒（如冷启动拉远程依赖）→ 探活超时

**部署返 200 但访问返 503**：进程跑起来过又崩了，或惰性重启失败。平台启动时不自动恢复进程；首次请求来了发现连不上才会 spawn，第一个访问者会多等最多 10 秒。

**排查手段**：在 main.ts 内部用 `try/catch` 把异常写进 `runtime/` 目录下的日志文件：

```typescript
try {
  Deno.serve({ hostname: "127.0.0.1", port }, handler);
} catch (e) {
  await Deno.writeTextFile("./crash.log", `${new Date().toISOString()} ${e}\n`, { append: true });
  throw e;
}
```

> `Deno.cwd()` = `data/app-{id}/runtime/`，跨部署保留；代码目录 `deploy-{a|b}/` 每次部署整体替换，不要写运行时数据进去。

### 7. L2 PB API 对 custom 类型不可用

`/web/agent-sites/apps/:id/api/*` 是 PocketBase 透传接口，**对 custom 类型返 400** `"Custom 类型 app {remoteAppId} 不支持 PocketBase API"`。custom app 的"后端 API"就是它自己 main.ts 里的路由，通过业务前端访问 `/{remoteAppId}/*` 调用。

### 8. 启用 PocketBase 后端（custom + enable_pb）

创建 custom app 时传 `"enable_pb": true`，平台会额外 spawn 一个 PocketBase 实例，并通过环境变量注入连接信息。**这不同于 L2 PB 透传**——custom 进程内用 PB SDK 直连 `127.0.0.1` 的 PB 实例。

#### 8a. 创建

```bash
RESP=$(curl -s -X POST $BASE/apps $AUTH \
  -d "{\"name\":\"my-app\",\"type\":\"custom\",\"enable_pb\":true,\"visibility\":\"private\",\"agentConfigId\":\"$AGENT_CONFIG_ID\"}")
APP_ID=$(echo "$RESP" | jq -r '.data.id')
REMOTE_APP_ID=$(echo "$RESP" | jq -r '.data.remoteAppId')
```

响应会额外包含 `enablePb: true` 和 `pbPort` 字段。

#### 8b. 环境变量

部署时平台向 custom 进程注入三个额外环境变量：

| 变量 | 值 | 用途 |
|------|---|------|
| `PB_URL` | `http://127.0.0.1:{pbPort}` | PB SDK 连接地址 |
| `PB_SUPERUSER_EMAIL` | `admin@{remoteAppId}.local` | superuser 邮箱 |
| `PB_SUPERUSER_PASSWORD` | `{uuid}` | superuser 密码 |

#### 8c. main.ts 示例

```typescript
import PocketBase from "npm:pocketbase";

const port = parseInt(Deno.env.get("PORT") || "8080");
const pbUrl = Deno.env.get("PB_URL");

let pb: PocketBase | undefined;
if (pbUrl) {
  pb = new PocketBase(pbUrl);
  await pb.collection("_superusers").authWithPassword(
    Deno.env.get("PB_SUPERUSER_EMAIL")!,
    Deno.env.get("PB_SUPERUSER_PASSWORD")!,
  );

  // 首次部署时初始化 collection（幂等）
  try {
    await pb.collections.create({
      name: "posts", type: "base",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "body", type: "text", required: true },
      ],
      listRule: "", viewRule: "", createRule: "", updateRule: null, deleteRule: null,
    });
  } catch (_) { /* 已存在 */ }
}

Deno.serve({ hostname: "127.0.0.1", port }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/api/posts") && req.method === "GET") {
    return Response.json(await pb!.collection("posts").getFullList());
  }
  // ... 前端 HTML 用相对路径 fetch("./api/posts")
});
```

**关键约定**：
- PB SDK 用 `npm:pocketbase`（Deno 原生支持 npm specifier）
- PB 只监听 127.0.0.1，外部不可达。custom 进程以 superuser 身份直连
- superuser 密码只在子进程环境变量中出现，不出 HTTP 响应
- 前端 API 调用走 custom 进程中转（不走 platform token）。前端 `fetch("./api/posts")` → custom 进程 → PB SDK
- 数据目录隔离：PB 数据在 `data/{remoteAppId}/pb_data/`，custom 运行时在 `data/{remoteAppId}/runtime/`
- **re-deploy 不重建 PB**：重新部署只更新 custom Deno 代码 + 双槽位切换，PB 实例和数据保留不动

## 站点卡片

建站或部署完成后，在聊天回复末尾**单独一行**输出 `<agent-sites>` 标签。该标签渲染为全宽度可点击卡片（左侧站点名称 + 右侧 "查看站点" 按钮），用户点击后右侧面板自动切到 Sites 视图并加载该站点。

### 格式

```
<agent-sites agent-site-id="app-91a0621c"/>
```

### 关键规则

- **单独一行**，前后不加任何文字或引导语（卡片自己就是醒目的 CTA）
- **不放代码块**——\` 和 ``` 都不行，否则渲染为纯文本
- **不放列表**——前面不要加 `-`、`*`、`1.`、`>`
- **不放缩进**——必须从行首开始
- `agent-site-id` 填建站 API 返回的 **`remoteAppId`**（形如 `app-xxxx`），不是 RCS 内部 UUID

### 正确示例

```
站点已创建，功能包括实时搜索、暗色主题、底部抽屉详情。

<agent-sites agent-site-id="app-abc123"/>
```

### 错误示例

```
- <agent-sites agent-site-id="app-abc123"/>    ← 列表前缀
`<agent-sites agent-site-id="app-abc123"/>`     ← 行内代码
<agent-sites agent-site-id="app-abc123"/> 点击打开 ← 多余引导语
```

`references/card-tag.md` 有更多示例，编写卡片标签前建议一并参考。

## 开发/业务智能体分权

Agent Sites 的**文件/配置修改**只能由**创建该 site 的智能体**（开发智能体）执行。其他绑定的智能体（业务智能体）可以操作 PocketBase 数据（L2 API），但无权修改 site 文件。

### 分权自检

在执行任何 L1 写入操作（创建 site 除外）之前，必须先执行自检：

1. **获取 site 详情**：`GET /web/agent-sites/apps/$APP_ID`
2. **对比 agent config id**：

```bash
CREATOR=$(echo "$SITE_RESP" | jq -r '.data.createdByAgentConfigId')
if [ "$CREATOR" != "null" ] && [ "$CREATOR" != "$AGENT_CONFIG_ID" ]; then
  echo "此 site 由其他智能体创建，我无权修改网站文件。请在右侧 Sites 面板点击「溯源」按钮回到创建者智能体操作。"
  exit 1
fi
```

3. **如果 `createdByAgentConfigId` 为 null**（创建者已删除）：所有绑定的智能体均可自由操作。

### 不受限制的操作

| 操作 | 限制 |
|------|------|
| L2 PB 数据 CRUD（`/web/agent-sites/apps/:id/api/*`） | ❌ 不限制 |
| 查看 site 详情/列表 | ❌ 不限制 |
| 创建新 site | ❌ 不限制（创建时传入 `agentConfigId` 成为创建者） |

### 受限制的操作（仅创建者或 `null` 兜底）

| 操作 | 必须自检 |
|------|---------|
| 上传静态文件（`PUT /apps/:id/files/:path`） | ✅ |
| 批量上传（`POST /apps/:id/files/bundle`） | ✅ |
| 部署 custom app（`POST /apps/:id/deploy`） | ✅ |
| 修改配置（`PATCH /apps/:id`） | ✅ |
| 删除 site（`DELETE /apps/:id`） | ✅ |
| 重签 token（`POST /apps/:id/rotate-token`） | ✅ |

## 开发约束

- 所有 API 调用走 `agent-platform-api` skill，不直连 agent-sites
- 凭证（master key / platform token）由 RCS 后端管理，agent 不接触
- 前端文件用 Write 工具创建、Edit 工具编辑，不用 shell 重定向
- **文件路径**：临时文件放当前目录 `./user/` 下；独立项目先 `mkdir <name>` 再编写；禁止放 `/tmp`
- name 仅允许 `[a-z0-9-]`，中文/大写/下划线被拒
- 每次创建 App 都是独立后端实例，不为不同用途复用 App 的 collection
