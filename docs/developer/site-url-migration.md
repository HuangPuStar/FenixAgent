# Agent Sites 前端 URL 路径规范

## 背景

Agent Sites（部署在 FenixAgent 平台上的业务前端）当前通过同源访问方式嵌入到 FenixAgent 控制台中：

```
旧路径: http://localhost:3000/app-e1895c18/...
新路径: http://localhost:3000/web/site/deploy/app-e1895c18/...
```

**旧路径已废弃**，平台侧不再处理 `/app-xxx/*` 这种根路由模式。

## 影响范围

如果你的站点前端代码中使用了**绝对路径**来请求 API 或静态资源，现在会 404：

```javascript
// ❌ 旧写法：以 /app-xxx 开头的绝对路径
fetch("/app-e1895c18/api/collections/news/records?sort=-publishedAt&perPage=50")
```

平台不再拦截 `/[appId]/*` 前缀的请求，上述路径将无法匹配到任何后端路由，直接返回 404。

## 解决方案

### 推荐：使用相对路径

将站点内部的所有 API 请求改为相对路径，让浏览器根据当前 iframe URL 自动拼接：

```javascript
// ✅ 新写法：相对路径
fetch("./api/collections/news/records?sort=-publishedAt&perPage=50")

// 或者不带 ./ 前缀的相对路径
fetch("api/collections/news/records?sort=-publishedAt&perPage=50")
```

因为站点部署在 `/web/site/deploy/[appId]/` 下，相对路径会自动解析为该前缀的子路径，不需要硬编码 appId。

### 检查清单

排查站点代码中是否存在以下硬编码绝对路径模式：

- `fetch("/api/...")` → `fetch("./api/...")`
- `new URL("/api/...", ...)` → `new URL("./api/...", ...)`
- `<a href="/...">` → `<a href="./...">`
- `<img src="/...">` → `<img src="./...">`
- `<script src="/...">` → `<script src="./...">`
- `<link href="/...">` → `<link href="./...">`
- WebSocket `new WebSocket("/...")` → `new WebSocket("./...")`

### 快速定位

在你的站点前端项目根目录执行以下 grep，找出所有以 `/` 开头的绝对路径引用：

```bash
grep -rn 'fetch("\/' --include='*.js' --include='*.ts' --include='*.jsx' --include='*.tsx' --include='*.html' .
grep -rn "fetch('\/" --include='*.js' --include='*.ts' --include='*.jsx' --include='*.tsx' --include='*.html' .
grep -rn 'new URL("\/' --include='*.js' --include='*.ts' .
grep -rn 'src="\/' --include='*.html' .
grep -rn 'href="\/' --include='*.html' .
```

如果是 PocketBase 自动生成的前端（如 PocketBase Admin UI），可能需要在配置中设置 `basePath`。

## 外部访问地址

如果用户从浏览器地址栏直接访问站点（而非通过 FenixAgent iframe 嵌入），正确的入口地址是：

```
https://<你的 FenixAgent 域名>/web/site/deploy/<你的 appId>/
```

例如：

```
https://fenix.example.com/web/site/deploy/app-e1895c18/
```

## 有问题？

联系 FenixAgent 平台运维获取帮助。
