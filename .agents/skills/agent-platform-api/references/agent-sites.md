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
  -d '{"name":"my-app","visibility":"private"}')
APP_ID=$(echo "$RESP" | jq -r '.data.id')
REMOTE_APP_ID=$(echo "$RESP" | jq -r '.data.remoteAppId')
echo "APP_ID=$APP_ID"
echo "REMOTE_APP_ID=$REMOTE_APP_ID"   # 形如 app-abcd1234
```

- `name` 只允许 `[a-z0-9-]`、长度 1..32；中文/大写/空格/下划线会被 400 拒绝
- `visibility`：`private`（仅创建者）/ `org`（组织内）/ `authenticated`（已登录）/ `public`（公开）。默认 `private`
- RCS 后端自持 platform token，不暴露给用户

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

> 极少数情况下，createApp 返回后立即建 collection 会返 503（PB superuser 凭证仍在异步落盘）。等 1-2 秒重试同一请求即可。

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

站点上线后，通过 RCS 代理访问（RCS 自动做 visibility 校验）：

```
$USER_META_BASE_URL/$REMOTE_APP_ID/
```

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

- 首次部署新 App：「✅ 站点已部署。打开右侧 **Sites** tab，点末尾的 **+** 按钮挂载预览。」
- 更新已上线前端：「✅ 前端已更新，已挂载的 site tab 会自动刷新。」
- 配置后端 collection 后：「✅ 后端就绪，在右侧 Sites tab 打开对应站点即可联调。」

> 挂载/卸载立即生效，**不需要重启 agent 实例**——绑定关系只由 RCS DB 维护，agent 运行时不消费。重复挂载走 PK 联合唯一 + `ON CONFLICT DO NOTHING`，幂等无副作用。

## 前端开发

### fetch 自动重写

浏览器 GET HTML 时 agent-sites 平台会注入 shim，把 `fetch('/api/x')` 自动重写成 `fetch('/{app_id}/api/x')`。前端绝对路径 `/api/...` 直接用。

fetch 以外的路径（`<a href>`、`<img src>`、`<link href>`、`axios`、`XMLHttpRequest`）不被 shim 覆盖，写成相对路径（`./api/x` 或 `api/x`）。

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

### 重签 Token

```bash
curl -s -X POST $BASE/apps/$APP_ID/rotate-token $AUTH
```

### 删除 App

真删：停远端 PB + 删数据 + 删前端 + 吊销所有 token，不可恢复。

```bash
curl -s -X DELETE $BASE/apps/$APP_ID $AUTH
```

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
