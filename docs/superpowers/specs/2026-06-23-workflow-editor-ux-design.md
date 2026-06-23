# Workflow Editor UX 改造设计（outputs 编辑 / custom 节点可发现性 / start 节点全局设置 / 一键发布）

**日期**：2026-06-23
**作者**：KonghaYao（与 Claude Code 协作）
**范围**：前端 workflow 编辑器 + 后端 yaml schema + 后端 custom tools API

---

## 背景

工作流编辑器存在 4 个明显影响用户体验的问题：

1. **编辑面板缺 outputs 编辑入口**：除 transform 类型有 `output` 编辑外，其余 7 种类型（shell/python/agent/api/audit/workflow/loop/custom）都没有 outputs 字段编辑。YAML schema 里 custom 类型支持 `outputs: { pattern, type }`，但前端没暴露。
2. **custom 节点缺可发现性**：custom 类型节点头不显示 tool 名（只显示"自定义"），左侧 palette 也没有 custom 工具入口。用户不知道系统注册了哪些 custom 工具。
3. **点击 start 节点显示无用 hint**：start 节点 popover 只显示一段文字提示，不显示工作流全局设置（name/description/timeout/params/secrets）。params 编辑还是 JSON textarea，不友好。
4. **缺一键发布入口**：发布按钮藏在 Sheet 形式的版本管理弹窗里，需要"List 按钮 → view all 链接 → Sheet 内的发布按钮"三步才能发布。

## 目标

- outputs 字段扩展到所有节点类型（同时改后端 schema）
- custom 工具通过新 API 暴露给前端，palette 列出已注册工具
- 点 start 节点直接显示全局设置；params 改为字段表单
- 右下角按钮组新增发布按钮，ConfirmDialog 二次确认

## 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| outputs schema 范围 | 把 outputs 从 `CustomNodeDef` 提升到 `BaseNodeDef`，所有类型都能声明 | yaml schema 统一，前端编辑器不用按类型分支 |
| custom 工具暴露方式 | 新增 `GET /web/workflow-custom-tools` 路由 + 前端 palette 分区 | registry 需要给前端一个稳定的查询入口 |
| start 节点 popover | 复用 `WorkflowMetaCard` | 与右下角齿轮弹出内容保持一致 |
| params 表单字段 | name + type + default + required（对齐后端 `ParamDef`） | 不扩展后端 schema，避免连带改动 |
| 发布按钮位置 | 右下角按钮组（VersionIndicator 和刷新之间） | 与现有按钮一致，不污染顶部工具栏 |
| 发布弹窗形态 | 简单 ConfirmDialog | handlePublish 已存在，弹窗只做二次确认 |

---

## §1 — 后端 Schema 变更（workflow-engine 包）

### 1.1 `packages/workflow-engine/src/types/dag.ts`

把 `outputs` 字段从 `CustomNodeDef` 移到 `BaseNodeDef`，改为可选：

```typescript
export interface BaseNodeDef {
  id: string;
  type: NodeType;
  description?: string;
  depends_on?: string[];
  condition?: string;
  timeout?: number;
  retry?: RetryConfig;
  env?: Record<string, string>;
  /** 输出声明。所有节点类型都可声明，key 为字段名，下游通过 nodes.X.outputs.<key> 引用 */
  outputs?: Record<string, {
    pattern: string;
    type: "file" | "file-list" | "dir";
  }>;
}
```

`CustomNodeDef.outputs` 原字段声明删除（继承自 BaseNodeDef），保留 doc comment 说明 custom 的 outputs 与 `CustomNode.produces` 的关系：custom 节点的 outputs 优先由 tool 注册时的 `produces` 驱动，yaml 中声明的 outputs 可作为覆盖或补充。

`TransformNodeDef` 保留自己的 `output: Record<string, string>`（单数）——语义不同：transform 的 output 是 JS 表达式 map（如 `{ result: "inputs.x.toUpperCase()" }`），不是 pattern。

`ParamDef` 不变（已支持 `type/default/required`）。

### 1.2 `packages/workflow-engine/src/parser/yaml-parser.ts`

把 `parseOutputs(n.outputs)` 调用从 custom 分支移到通用分支（所有节点类型解析时都调用）：

```typescript
// 在 parseNode 或等价的通用处理函数中
function parseCommonFields(raw: RawNode): Partial<BaseNodeDef> {
  return {
    // ...其他通用字段
    outputs: parseOutputs(raw.outputs),
  };
}
```

所有 NodeDef 解析（shell/python/agent/...）都通过 spread 继承这个通用字段集。

### 1.3 测试影响

- 现有 custom 节点 outputs 测试（`yaml-parser.test.ts` 多处）保持不变，验证回归
- 新增测试用例：shell 节点声明 `outputs: { result: { pattern: "/tmp/out", type: "file" } }` 的 yaml 能正确解析为 `ShellNodeDef.outputs`

### 1.4 前端 `flowToYaml` 兼容性

`web/src/pages/workflow/yaml-utils.ts` 的 `flowToYaml` 第 180 行已经会把 `node.data` 上所有非 `_` 开头、非空的字段写入 yaml。前端写入 outputs 后会自然进入 yaml，**无需改 flowToYaml**。

但要注意：空对象 `{}` 不会被现有逻辑跳过（`v !== ""` 判断对空对象为 true），需要 OutputsEditor/ParamsEditor 在 entries 全部删除时返回 `undefined`，而不是空对象。

### 1.5 风险

- **schema 提升破坏旧 yaml**：旧 yaml 中只有 custom 节点有 outputs 字段，提升后其他类型若意外写了 outputs 也会被解析。这其实是新能力，不算破坏。
- **transform output vs outputs**：两个字段语义不同，文档和注释需要强调区分，避免用户混淆。

---

## §2 — 后端 API 新增 + 前端 API Client

### 2.1 后端：新增 `workflow-custom-tools` 路由

**文件**：`src/routes/web/workflow-custom-tools.ts`（新建）

```typescript
// GET /web/workflow-custom-tools
// 返回：{ success: true, data: [{ name, description, inputs, produces }] }
//
// 数据源：getCustomToolsRegistry().list() —— 同步读取已初始化的 registry。
// 不需要 organizationId 过滤：tools 是全局注册的，按 team 隔离的是 engine 实例
// 而非 tool 定义本身。仍挂 authGuardPlugin，要求登录。
```

挂载到 `src/routes/web/index.ts` 的 web 路由聚合，仿 `workflow-defs.ts` 挂载方式。

### 2.2 前端 API client

**文件**：`web/src/api/workflow-defs.ts`（沿用此文件，因为它已经是 workflow 域的 API 客户端）

```typescript
export interface CustomToolItem {
  name: string;
  description?: string;
  inputs?: Array<{ key: string; /* 其他字段按 registry.list() 实际返回 */ }>;
  produces?: string[];
}

export const customToolsApi = {
  list: async (): Promise<CustomToolItem[]> => {
    const r = await fetch("/web/workflow-custom-tools", { credentials: "include" });
    const json = await r.json();
    return json.success ? json.data : [];
  },
};
```

### 2.3 拉取时机

`WorkflowEditorInner` mount 时调用一次 `customToolsApi.list()`，存到 `customTools` state（不依赖 workflowId，因为 tools 是全局的）。`customTools` 传入：

1. 左侧 palette（渲染 custom 工具按钮）
2. `NodeConfigPopover` → `NodeConfigCard`（custom 类型时，tool 字段改为 datalist，下拉显示已注册工具）

### 2.4 测试覆盖

- 后端：`src/__tests__/routes/workflow-custom-tools.test.ts` — L3 测试，stub `getCustomToolsRegistry()`，验证：
  1. 已登录返回 `registry.list()` 数据结构
  2. 未登录返回 401
  3. registry 为空时返回 `[]`
- 前端：不写专门测试，API 调用 mock 模式参照 `workflow-defs-flow.test.ts` 即可。

---

## §3 — 前端：NodeConfigCard 重构 + outputs/params/custom tool 编辑

### 3.1 新组件 `OutputsEditor.tsx`

**文件**：`web/src/pages/workflow/components/OutputsEditor.tsx`（新建）

仿 `InputsEditor.tsx` 模式，每行 **3 列**：

```
[key input 30%] [pattern input flex-1] [type select 80px] [删除按钮]
[+ 添加产出]
```

- **value**：`Record<string, { pattern: string; type: "file" | "file-list" | "dir" }>` 或 undefined
- **onChange**：清空所有 entries 时返回 undefined（与 InputsEditor 一致，避免空对象写入 yaml）
- **type 默认**：`"file"`
- **readOnly 模式**：禁用所有 input 和按钮
- **删除二次确认**：沿用 InputsEditor 的"首次点击进入确认态 + 3 秒后自动取消 + 再次点击真正删除"模式

### 3.2 新组件 `ParamsEditor.tsx`

**文件**：`web/src/pages/workflow/components/ParamsEditor.tsx`（新建）

每行 **4 列**：

```
[name input 28%] [type select 80px] [default input flex-1] [required checkbox] [删除]
[+ 添加参数]
```

- **value**：`Record<string, { type?: "string"|"number"|"boolean"|"object"; default?: unknown; required?: boolean }>`
- **onChange**：同 OutputsEditor，空时返回 undefined
- **type 默认**：`"string"`
- **default 输入控件按 type 切换**：
  - `string` → `<input type="text">`
  - `number` → `<input type="number">`，存 `Number(value)`
  - `boolean` → `<input type="checkbox">`
  - `object` → `<textarea>`（用户输入 JSON，校验失败时红色边框但不崩溃，参照原 `WorkflowMetaCard` 的 JSON textarea 实现）
- **type 切换时 default 清空**：避免类型不匹配（如 number 切换到 object 留下数字）
- **required**：单个 checkbox

### 3.3 `NodeConfigCard.tsx` 修改

#### 3.3.1 所有非 start、非 transform 类型新增 outputs 编辑区块

在每种类型的"节点配置"区块底部加：

```tsx
<div className="wf-prop-field">
  <label>{t("editor.outputs_title")}</label>
  <OutputsEditor
    value={sd?.outputs as Record<string, { pattern: string; type: ... }> | undefined}
    onChange={(val) => updateNodeData({ outputs: val })}
    readOnly={readOnly}
    addLabel={t("editor.outputs_add")}
  />
</div>
```

适用类型：shell / python / agent / api / audit / workflow / loop / custom。

对 custom 类型：保留原注释逻辑（custom 的 outputs 优先由 `tool.produces` 驱动），但允许用户在 outputs 区块手动声明或覆盖。这样 yaml schema 提升到 BaseNodeDef 后能被正确解析。

#### 3.3.2 custom 类型的 tool 字段从 input 改为 datalist

```tsx
<input
  list="custom-tools-list"
  value={String(sd?.tool ?? "")}
  onChange={(e) => updateNodeData({ tool: e.target.value || undefined })}
  placeholder={t("editor.custom_tool_placeholder")}
  readOnly={readOnly}
/>
<datalist id="custom-tools-list">
  {customTools.map(t => (
    <option key={t.name} value={t.name}>{t.description}</option>
  ))}
</datalist>
```

用 datalist 而非 select：既允许下拉选择已注册工具，也允许手填（兼容 tool 未注册时的容错场景）。

#### 3.3.3 isStartNode 分支：从 hint 改为 WorkflowMetaCard

```tsx
{isStartNode ? (
  <WorkflowMetaCard readOnly={readOnly} meta={meta} updateMeta={updateMeta} />
) : (
  // 原节点配置逻辑保持不变
)}
```

需要把 `meta` 和 `updateMeta` 通过 props 传入 `NodeConfigCard`（当前没传）。`NodeConfigPopover` 同步增加这两个 prop 透传。

### 3.4 `WorkflowMetaCard.tsx` 修改

把原来的 params JSON textarea 替换为 `<ParamsEditor>`：

```tsx
<div className="wf-prop-section">
  <div className="wf-prop-section-title">{t("editor.params")}</div>
  <ParamsEditor
    value={meta.params}
    onChange={(val) => updateMeta({ params: val ?? {} })}
    readOnly={readOnly}
    addLabel={t("editor.params_add")}
  />
</div>
```

注意：`meta.params` 类型是 `Record<string, unknown>`，ParamsEditor 内部需要做类型断言或加运行时校验。最稳的做法：在 ParamsEditor 入口处用 `isParamsRecord(x)` 守卫，不通过则视为空。

### 3.5 `NodeConfigPopover.tsx` 修改

1. 新增 props：`meta`、`updateMeta`、`customTools`
2. 透传到 `NodeConfigCard`
3. popover header 标题在 isStartNode 时改为 `t("editor.workflow_settings")`，否则保留 `selectedNode.id`

### 3.6 i18n key 新增（en + zh）

`web/src/i18n/locales/{en,zh}/workflows.json`：

| key | en | zh |
|-----|----|----|
| `editor.outputs_title` | Outputs | 输出声明 |
| `editor.outputs_add` | Add output | 添加产出 |
| `editor.outputs_key_placeholder` | field name | 字段名 |
| `editor.outputs_pattern_placeholder` | path pattern (e.g. /tmp/out) | 路径模式（如 /tmp/out） |
| `editor.params_add` | Add parameter | 添加参数 |
| `editor.params_name_placeholder` | param name | 参数名 |
| `editor.params_default_placeholder` | default value | 默认值 |
| `editor.custom_tool_placeholder` | Select or type tool name | 选择或输入工具名 |
| `editor.workflow_settings` | Workflow Settings | 工作流设置 |
| `editor.palette_custom_tools` | Custom Tools | 自定义工具 |
| `editor.tooltip_publish` | Publish new version | 发布新版本 |
| `editor.publish_confirm_title` | Publish New Version | 发布新版本 |
| `editor.publish_confirm_desc` | A new version will be created from the current draft. Latest: {{latest}}. Continue? | 将以当前草稿创建新版本，当前最新版本：{{latest}}。是否继续？ |

### 3.7 边界情况

- **空对象写入 yaml**：ParamsEditor/OutputsEditor 必须在 entries 全删时返回 undefined，不能返回 `{}`。否则 `flowToYaml` 会写入 `outputs: {}` 这种冗余字段。
- **旧 yaml 没有 outputs 字段**：新前端读取时 `sd?.outputs` 是 undefined，渲染空列表，正常。
- **previewVersion 模式下的 readOnly**：start 节点显示的 WorkflowMetaCard 也会被 readOnly，自动只读，无需额外处理。
- **default 字段类型不匹配**：用户切换 type 后，原 default 值可能不再合法（如 number 切换到 object）。ParamsEditor 在 type 切换时清空 default，避免脏数据。

---

## §4 — 节点卡片显示 tool 名 + 左侧 palette 添加 custom 分区

### 4.1 `nodes.tsx` — 节点头主标题优先级调整

当前 `nodeSubtitle = description || id`。改为：

```typescript
// 优先级：description > tool 名（仅 custom）> id
// 让 custom 节点没填 description 时至少能看到 tool 名（如 "trim_galore"），
// 而不是冷冰冰的 "custom_2"。其他类型不受影响。
const toolName = typeof d.tool === "string" ? d.tool.trim() : "";
const nodeSubtitle = isStart
  ? ""
  : description || (nodeType === "custom" && toolName ? toolName : id);
```

副标题（label）保持不变：custom 类型副标题仍是 `t("nodes.custom")`（"自定义"）。节点头变成两行：

```
[图标] trim_galore           ← 主标题（tool 名）
       自定义                  ← 副标题（类型 label）
```

如果用户填了 description，则主标题是 description，副标题仍是"自定义"。

### 4.2 `WorkflowEditor.tsx` — 左侧 palette 添加 custom 分区

#### 4.2.1 新增 state + API 调用

```typescript
const [customTools, setCustomTools] = useState<CustomToolItem[]>([]);

useEffect(() => {
  customToolsApi.list().then(setCustomTools).catch((err) => {
    console.error("Failed to load custom tools:", err);
    // 失败不阻塞编辑器，palette 显示空 custom 分区
  });
}, []);
```

#### 4.2.2 palette 渲染

在 `BASIC_PALETTE_ITEMS` 后、第一个 `wf-palette-divider` 后、`TRANSFORM_PRESETS` 前插入 custom 分区：

```tsx
{customTools.length > 0 && (
  <>
    <div className="wf-palette-divider" />
    <div className="wf-palette-group-title">{t("editor.palette_custom_tools")}</div>
    {customTools.map((tool) => (
      <button
        key={tool.name}
        type="button"
        className="wf-palette-btn"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/workflow-node", "custom");
          e.dataTransfer.setData("application/workflow-tool", tool.name);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => addNode("custom", undefined, undefined, tool.name)}
        title={tool.description}
      >
        <span className="wf-palette-icon" style={{ background: "#8b5cf6" }}>
          <Boxes size={14} />
        </span>
        {tool.name}
      </button>
    ))}
  </>
)}
```

#### 4.2.3 `addNode` 扩展支持 tool 参数

当前签名 `addNode(type, presetOrPosition, positionFallback)`。扩展为：

```typescript
addNode: (
  type: string,
  presetOrPosition?: string | { x: number; y: number },
  positionFallback?: { x: number; y: number },
  tool?: string,  // 新增
) => void;
```

实现中：如果 `type === "custom"` 且 `tool` 非空，写入 `newNode.data.tool = tool`。`tool.produces` 预填 outputs 是 nice-to-have，本期不做（避免过度设计）。

#### 4.2.4 `onDrop` 同步扩展

```typescript
const onDrop = useCallback((event: React.DragEvent) => {
  event.preventDefault();
  const type = event.dataTransfer.getData("application/workflow-node");
  if (!type) return;
  const preset = event.dataTransfer.getData("application/workflow-preset");
  const tool = event.dataTransfer.getData("application/workflow-tool") || undefined;
  const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
  if (type === "custom" && tool) {
    addNode("custom", position, undefined, tool);
  } else {
    addNode(type, preset || position, preset ? position : undefined);
  }
}, [screenToFlowPosition, addNode]);
```

### 4.3 `NodeConfigCard.tsx` — custom tool 字段用 datalist

§3.3.2 已规划，数据来源：`customTools` 通过 props 从 `WorkflowEditor` 透传 → `NodeConfigPopover` → `NodeConfigCard`。

prop 链：

```
WorkflowEditor
  └─ customTools (state)
       ↓ prop
NodeConfigPopover (props.customTools)
  └─ NodeConfigCard (props.customTools)
```

### 4.4 边界情况

- **registry 为空**：palette 不显示 custom 分区（`customTools.length > 0` 守卫）。用户仍可通过 NodeConfigCard 的 type 下拉框切到 custom，手填 tool 名。
- **registry 加载失败**：toast 不弹（避免干扰），仅 `console.error`。palette 静默退化。
- **tool 名重复**：palette 中按 registry 返回顺序渲染，不去重（registry 自身应该保证唯一）。
- **节点已存在但 tool 名修改**：节点头主标题实时跟随 tool 字段变化（reactive），无需额外联动。

### 4.5 风险

- **`addNode` 签名变更**：现有调用方（`BASIC_PALETTE_ITEMS.onClick`、`TRANSFORM_PRESETS.onClick`、`onDrop`）签名不变（新参数可选）。实施时 grep 确认所有调用点不破坏。
- **palette 高度溢出**：基础节点（5）+ transform 预设（若干）+ custom 工具（可能多个）可能超出画布高度。`wf-palette` 容器需要 `overflow-y: auto`（检查现有 CSS 是否已支持）。

---

## §5 — 发布按钮 + 错误处理 + 测试 + 完整文件清单

### 5.1 发布按钮（右下角按钮组）

**位置**：`WorkflowEditor.tsx` 的 `wf-bottom-actions` 中，`VersionIndicator` 之后、刷新按钮之前。

```tsx
<VersionIndicator ... />

{/* 发布按钮：复用 handlePublish，ConfirmDialog 二次确认 */}
<button
  type="button"
  className="wf-meta-trigger-btn wf-publish-btn"
  disabled={!workflowId || publishing || effectiveReadOnly}
  title={t("editor.tooltip_publish")}
  onClick={() => setPublishConfirmOpen(true)}
  style={{
    background: publishing ? "#d1d5db" : "#22c55e",
    color: "#fff",
    borderColor: publishing ? "#d1d5db" : "#22c55e",
  }}
>
  <Rocket size={14} />
</button>

<button
  type="button"
  className="wf-meta-trigger-btn"
  disabled={isRunMode && !isRunDone}
  title={t("editor.tooltip_refresh")}
  onClick={handleRefreshDraft}
>
  <RefreshCw size={14} />
</button>
```

**ConfirmDialog**（与现有删除确认同模式，顶层渲染，避免被 popover outside-click 卸载）：

```tsx
<ConfirmDialog
  open={publishConfirmOpen}
  onOpenChange={setPublishConfirmOpen}
  title={t("editor.publish_confirm_title")}
  description={t("editor.publish_confirm_desc", {
    latest: wfData?.latestVersion ? `v${wfData.latestVersion}` : t("editor.no_published"),
  })}
  variant="default"
  onConfirm={async () => {
    setPublishConfirmOpen(false);
    await handlePublish();
  }}
/>
```

**disabled 条件说明**：

- `!workflowId` — 新建未保存的 workflow 不能发布（无 id）
- `publishing` — 发布中防抖（useWorkflowPersistence 已暴露 publishing 状态）
- `effectiveReadOnly` — 运行模式 / 版本预览下禁止发布

### 5.2 错误处理矩阵

| 场景 | 处理 |
|------|------|
| custom tools API 拉取失败 | `console.error` + 静默退化（palette 不显示 custom 分区），不 toast |
| `addNode` 时 type 未注册（极端） | ReactFlow 已有兜底（`nodes.tsx` 注释提到 custom 注册项），不额外处理 |
| ParamsEditor default 输入非法 JSON（object 类型） | 红色边框 + 不更新 state（用户继续编辑），参照原 textarea 实现 |
| OutputsEditor 空 key | 红色边框警告 + 保存时 `flowToYaml` 仍写入（yaml-utils 已处理） |
| handlePublish 失败 | 现有逻辑：`pushWorkflowError` + `toast.error`，不变 |
| outputs 字段非对象（旧 yaml 异常数据） | OutputsEditor value 兜底为 undefined，渲染空列表 |
| params 字段非对象（旧 yaml 异常） | ParamsEditor 同上 |
| ConfirmDialog 打开期间外部状态变化 | onConfirm 内重新读 state（闭包），但 effectiveReadOnly 变化时按钮已 disabled，不会触发 |

### 5.3 测试覆盖

| 层 | 文件 | 测试点 |
|----|------|--------|
| 后端 L3 | `src/__tests__/routes/workflow-custom-tools.test.ts`（新建） | 1) 已登录返回 `registry.list()` 数据；2) 未登录 401；3) registry 为空返回 `[]` |
| 后端 L1 | `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts`（补充） | shell 节点声明 outputs 的 yaml 能正确解析为 `ShellNodeDef.outputs` |
| 前端 | `web/src/__tests__/workflow-params-outputs-flow.test.ts`（新建） | 1) ParamsEditor 增删参数触发 onChange；2) OutputsEditor 同；3) NodeConfigCard 在 isStartNode 时渲染 WorkflowMetaCard（mock customToolsApi） |

后端 workflow-engine 包的测试独立运行（`packages/workflow-engine/` 有独立 package.json），需在那边补 yaml-parser 测试。

前端测试用 React Testing Library + fetch mock（参照 `web/src/__tests__/config-mcp-page.test.ts` 模式）。

### 5.4 完整文件清单

#### 新建（5 个）

| 文件 | 用途 |
|------|------|
| `src/routes/web/workflow-custom-tools.ts` | GET /web/workflow-custom-tools 路由 |
| `src/__tests__/routes/workflow-custom-tools.test.ts` | 后端 L3 测试 |
| `web/src/pages/workflow/components/OutputsEditor.tsx` | outputs 编辑器 |
| `web/src/pages/workflow/components/ParamsEditor.tsx` | params 编辑器 |
| `web/src/__tests__/workflow-params-outputs-flow.test.ts` | 前端关键流程测试 |

#### 修改（13 个）

| 文件 | 改动摘要 |
|------|----------|
| `packages/workflow-engine/src/types/dag.ts` | `outputs` 从 CustomNodeDef 移到 BaseNodeDef |
| `packages/workflow-engine/src/parser/yaml-parser.ts` | `parseOutputs` 提升到通用分支 |
| `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts` | 补 shell+outputs 测试用例 |
| `src/routes/web/index.ts` | 注册 workflow-custom-tools 路由 |
| `web/src/api/workflow-defs.ts` | 加 `customToolsApi.list()` + `CustomToolItem` 类型 |
| `web/src/pages/workflow/WorkflowEditor.tsx` | customTools state + palette 分区 + 发布按钮 + ConfirmDialog |
| `web/src/pages/workflow/hooks/useWorkflowCanvas.ts` | `addNode` 增加 tool 参数 + onDrop 适配 |
| `web/src/pages/workflow/components/NodeConfigCard.tsx` | 所有非 start 非 transform 类型加 outputs + custom tool datalist + isStartNode 渲染 WorkflowMetaCard |
| `web/src/pages/workflow/components/NodeConfigPopover.tsx` | 透传 meta/updateMeta/customTools props + header 标题 |
| `web/src/pages/workflow/components/WorkflowMetaCard.tsx` | JSON textarea 换为 ParamsEditor |
| `web/src/pages/workflow/nodes.tsx` | custom 节点主标题优先用 tool 名 |
| `web/src/i18n/locales/en/workflows.json` | 新增 i18n key |
| `web/src/i18n/locales/zh/workflows.json` | 新增 i18n key |

### 5.5 验收清单（实施完成后逐项核对）

- [ ] shell 节点编辑面板有 outputs 区块，能增删改 outputs 字段
- [ ] custom 节点编辑面板的 tool 字段是 datalist，能下拉选择 registry 中的工具
- [ ] custom 节点头主标题显示 tool 名（无 description 时）
- [ ] 左侧 palette 在基础节点和 transform 预设之间有"自定义工具"分区
- [ ] 点击 start 节点 → popover 显示 name/description/timeout/params 表单/secrets
- [ ] params 表单每行有 name/type/default/required 4 个字段，type=boolean 时 default 是 checkbox，type=object 时是 textarea
- [ ] 右下角 VersionIndicator 和刷新按钮之间有绿色发布按钮
- [ ] 点发布按钮 → ConfirmDialog → 确认后调用 handlePublish + toast
- [ ] previewVersion / run 模式下发布按钮 disabled
- [ ] 后端 yaml-parser 能解析 shell 节点的 outputs 字段
- [ ] `bun run precheck` 全部通过
- [ ] `bun test src/__tests__/` 通过
- [ ] `bun test web/src/__tests__/` 通过
- [ ] `bun test packages/workflow-engine/src/__tests__/` 通过

### 5.6 实施顺序建议

1. **后端 schema（§1）**：先改 dag.ts + yaml-parser.ts + 补 workflow-engine 测试，独立提交。基础稳了再做上层。
2. **后端 API（§2）**：新建 workflow-custom-tools 路由 + L3 测试，独立提交。
3. **前端新组件（§3.1, §3.2）**：OutputsEditor + ParamsEditor，可独立测试。
4. **前端集成（§3.3-§3.6, §4）**：NodeConfigCard / WorkflowMetaCard / NodeConfigPopover / WorkflowEditor / nodes.tsx 改造，一次性提交（互相依赖多）。
5. **发布按钮（§5.1）**：单独提交，与前面解耦。
6. **i18n + 测试**：随对应功能一起提交。

每步完成后跑 `bun run precheck` + 对应层测试，绿了再进入下一步。
