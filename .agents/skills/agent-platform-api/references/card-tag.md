# 站点卡片标签

聊天中输出 `<agent-sites>` 标签，渲染为内嵌站点预览卡片。卡片下方展示可点击的「查看站点」按钮，上方展示站点 iframe 实时预览。

## 格式

```
<agent-sites agent-site-id="app-91a0621c" url="https://rcs.example.com/app-91a0621c/"/>
```

- `agent-site-id` 填建站 API 返回的 `remoteAppId`（形如 `app-xxxx`），卡片内核按需用
- `url` 填完整可访问 URL，**必须先用 `echo "$USER_META_BASE_URL/$REMOTE_APP_ID/"` 解析后填入真实域名**，卡片渲染为 iframe 预览 + 下方按钮

## 规则

### 必须

- **单独一行**，前后不加任何文字
- **放在回复最末尾**，自成一段
- `agent-site-id` 填建站 API 返回的 `remoteAppId`（形如 `app-xxxx`），不是 RCS 内部 UUID
- `url` 填 `echo "$USER_META_BASE_URL/$REMOTE_APP_ID/"` 输出的完整真实 URL，禁止填 `$USER_META_BASE_URL` 占位符

### 禁止

| 操作 | 说明 |
|------|------|
| 包裹代码块 | \` 行内代码和 ``` 代码围栏都不行，会导致渲染为纯文本 |
| 列表前缀 | `-`、`*`、`1.` 前导 |
| 引用前缀 | `>` 前导 |
| 缩进 | 必须从行首开始 |
| 标签前后加引导语 | 如 "点击下方卡片"——卡片自己渲染为 iframe + 按钮 |
| url 填环境变量占位符 | 如 `url="$USER_META_BASE_URL/app-abc/"` 会被前端当作字面字符串，无法加载 |

### 正确

```
站点已创建，首页功能包括实时搜索、暗色主题。

功能一览：
- 搜索框：实时过滤
- 预置股票：AAPL、GOOGL、MSFT

<agent-sites agent-site-id="app-abc123" url="https://rcs.example.com/app-abc123/"/>
```

### 错误

```
- <agent-sites agent-site-id="app-abc123" url="https://rcs.example.com/app-abc/"/>   ← 列表前缀
`<agent-sites agent-site-id="app-abc123" url="https://rcs.example.com/app-abc/"/>`    ← 行内代码
<agent-sites agent-site-id="app-abc123" url="https://rcs.example.com/app-abc/"/> 点这里打开 ← 多余引导语
<agent-sites agent-site-id="app-abc123" url="$USER_META_BASE_URL/app-abc/"/>  ← url 是占位符
```

- 多站点时：每站点一行标签

## 效果

卡片渲染为全宽度组件，上下两部分：
- **上方**：iframe 实时预览站点，高度 300px 左右，带圆角和边框
- **下方**：Globe 图标 + 站点名称 +「查看站点」按钮。点击按钮 → 右侧面板切换到 Sites 视图 → 加载该站点
