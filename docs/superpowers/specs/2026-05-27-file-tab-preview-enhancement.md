# Chat 区域 ArtifactsPanel 文件预览增强设计

**日期**：2026-05-27
**范围**：v2 Agent Panel → ArtifactsPanel → PreviewTab 增强预览能力
**状态**：已确认

---

## 背景

当前 ArtifactsPanel 右侧面板的文件预览功能（`PreviewTab`）仅支持纯文本 `<pre>` 渲染，无法识别文件类型。代码文件没有语法高亮，图片和 PDF 无法预览，二进制文件只显示"非文本文件"提示。

本次改动聚焦于增强预览能力，不涉及文件树、tab 栏或交互流程的变更。

## 需求范围

### 要做的

- 代码文件：shiki 语法高亮，自动语言识别，显示行号
- 图片文件：内联预览（png/jpg/jpeg/gif/svg/webp/ico/bmp）
- PDF 文件：iframe 内嵌预览
- 其他二进制文件：显示文件名、类型、大小等信息卡片

### 不做的

- 文件编辑
- 文件 diff 对比
- 文件搜索（文件名搜索或全文搜索）
- 多文件 tab 切换 / 历史记录导航
- 大文件虚拟滚动 / 懒加载

## 实现方案

按文件类型拆分预览子组件，`PreviewTab` 作为路由组件分发到对应预览器。

### 文件结构

```
web/src/components/agent-panel/
├── FileTreeTab.tsx              # 不变
├── FileTreeContextMenu.tsx      # 不变
├── PreviewTab.tsx               # 改造：文件类型路由
├── preview/
│   ├── CodePreview.tsx          # 新建：shiki 语法高亮
│   ├── ImagePreview.tsx         # 新建：图片内联预览
│   ├── PdfPreview.tsx           # 新建：PDF iframe 预览
│   ├── BinaryInfoPreview.tsx    # 新建：二进制文件信息卡片
│   └── utils.ts                 # 新建：文件类型分类工具函数
```

### 文件类型分类

| 类别 | 扩展名 | 预览组件 |
|------|--------|----------|
| 代码 | `.ts/.tsx/.js/.jsx/.py/.go/.rs/.json/.yaml/.yml/.css/.html/.md/.sh/.sql/.toml/.xml/.rb/.java/.c/.cpp/.h/.hpp/.r/.swift/.kt` 等 | `CodePreview` |
| 图片 | `.png/.jpg/.jpeg/.gif/.svg/.webp/.ico/.bmp` | `ImagePreview` |
| PDF | `.pdf` | `PdfPreview` |
| 其他 | 未匹配的扩展名，或 API 返回非文本内容 | `BinaryInfoPreview` |

### 组件设计

#### `utils.ts`

- `classifyFile(filePath: string): 'code' | 'image' | 'pdf' | 'binary'` — 根据扩展名分类
- `getShikiLanguage(filePath: string): string | undefined` — 扩展名映射到 shiki 语言 ID，未识别返回 `undefined`（fallback 纯文本）

#### `PreviewTab.tsx`（改造）

1. 用 `classifyFile(filePath)` 判断文件类型
2. **代码文件**：调用现有 `readFile` API 获取文本 content，传给 `CodePreview`
3. **图片/PDF**：不调用 `readFile`，直接传 `envId` + `filePath` 给对应组件，由组件构造 HTTP URL
4. **二进制文件**：调用 `readFile` 获取文件元信息（大小等），传给 `BinaryInfoPreview`
5. 保持现有的 loading / error 状态处理

#### `CodePreview`

- Props：`content: string`、`filePath: string`
- 使用 shiki `codeToHtml()` API 渲染语法高亮
- 使用 dark 主题（与面板背景协调）
- 通过 `getShikiLanguage()` 映射语言，未识别时 fallback 纯文本
- 显示行号（shiki `transformLineNumbers`）
- 首次渲染时异步加载 shiki 主题和语言，显示 loading 状态
- 容器 `<pre>` 包裹 shiki 输出 HTML，`overflow-auto` 支持滚动

#### `ImagePreview`

- Props：`envId: string`、`filePath: string`
- 构造文件 API URL（`/web/sessions/:id/user/:path`），`<img>` 标签直接加载
- 居中显示，`max-width: 100%`、`max-height: 100%`，保持原始宽高比
- 小图片原始尺寸居中

#### `PdfPreview`

- Props：`envId: string`、`filePath: string`
- `<iframe>` 嵌入，`src` 指向文件 API URL
- 占满预览区域（`width: 100%`、`height: 100%`）
- 浏览器原生 PDF 渲染，支持滚动和缩放
- iframe 加载失败时显示降级提示

#### `BinaryInfoPreview`

- Props：`filePath: string`、`fileSize?: number`
- 显示文件名、文件类型描述、文件大小的信息卡片
- 根据文件类型显示对应 lucide 图标
- 提示"此文件类型不支持预览"

### i18n

在 `web/src/i18n/locales/{en,zh}/components.json` 的 `fileTree.preview` 下新增翻译键：

- `unsupportedType`：此文件类型不支持预览 / This file type cannot be previewed
- `fileSize`：文件大小 / File size
- `fileType`：文件类型 / File type

## 依赖

- **shiki**：已有依赖（`package.json` 中 `^4.1.0`），直接使用，无需新增
- **无新增外部依赖**

## 不涉及的改动

- 文件树（`FileTreeTab`）不变
- tab 栏（`ArtifactsPanel` 的 tab 部分）不变
- ArtifactsPanel 布局不变
- 后端 API 不变
