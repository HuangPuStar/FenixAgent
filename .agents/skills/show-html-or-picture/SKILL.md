---
name: show-html-or-picture
description: 当需要把本地 HTML 或图片文件展示给前端时使用。优先引用当前工作目录下的 user/ 目录中的文件；如果文件在其他位置，先复制到当前工作目录的 user/ 再展示。路径由前端自动改写为 /fs/ 路由代理，Agent 只需输出 user/ 相对路径即可。最终只输出可直接渲染的相对路径片段：HTML 输出 iframe，图片输出 Markdown 图片；路径不能是绝对路径，也不能以 / 开头，且不要附加额外说明文字。
---

把本地 HTML 或图片展示给前端。

由于本系统只允许将 `./user/` 目录（包括子目录）下的文件在对话中显示预览，所以要以当前工作目录为基准，将要预览的文件以及它的全部依赖文件全部原样复制到 `./user/` 或其子目录中。

## 路径基准
- **基准目录**: 当前工作目录（`pwd`/`cwd` 输出的路径）下的 `user/` 子目录
- **示例**: 如果当前工作目录是 `/app/workspaces/env_xxx`，则文件应放在 `/app/workspaces/env_xxx/user/`
- **常见错误**: 不要使用 `/app/workspaces/user/`（这是 workspace root 下的 user 目录，不是当前工作目录）

## 执行流程
1. **检查文件是否存在**于 `./user/` 目录（包括子目录）下。
2. 如果不存在，**尝试查找文件**的当前位置（用户可能提供了完整路径或文件名）。
3. 如果找到文件但不在 `./user/`，**必须复制**到 `./user/` 目录（包括子目录）下。

## 复制命令示例
```bash
# 从其他位置复制到当前工作目录的 user/
cp /path/to/source/file.html ./user/

# 如果 user/ 目录不存在，先创建
mkdir -p ./user/
cp /path/to/source/file.html ./user/
```

> 对于交互式图表、地图等复杂网页，注意要将 HTML 文件及其所有相关的 CSS, Javascript, 图片等文件全部原样复制。

## 输出规范
- **只输出一行**可渲染内容，不要加解释、代码块或其他文字
- 路径必须是相对路径，格式为 `./user/<filename>`
- **不能使用绝对路径**或 `/` 开头路径

### HTML 输出
```html
<iframe src="./user/xxx.html" width="100%" height="400" />
```

或根据内容调整高度：

```html
<iframe src="./user/xxx.html" width="100%" height="600" />
```

### 图片输出
```markdown
![description](./user/xxx.png)
```

## 错误处理
如果文件未找到，返回明确的错误信息：

## 注意事项
- 默认复制，不移动；除非用户明确要求，否则不要输出复制命令
- 如果文件已经在 `./user/` 中，直接使用，无需再次复制
- 文件名应包含用途，时间戳或日期，避免覆盖现有文件
- 前端会自动将 `./user/xxx` 改写为 `/web/environments/{envId}/fs/user/xxx?preview=true`

## 示例

### 示例 1：文件已在 user/ 目录

用户输入：展示飞行报告
文件位置：`./user/flight_report_20260810.html`

输出：
```html
<iframe src="./user/flight_report_20260810.html" width="100%" height="600" />
```

### 示例 2：文件在其他位置，需要复制

用户输入：展示 /tmp/heatmap.html
文件位置：`/tmp/heatmap.html`

执行：
```bash
cp /tmp/heatmap.html ./user/
```

输出：
```html
<iframe src="./user/heatmap.html" width="100%" height="400" />
```
