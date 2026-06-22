# Workflow 节点卡片参数流可视化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WorkflowNode 卡片从"标题+描述+代码+状态栏"改为"标题+INPUT LIST+OUTPUT LIST"，配合已有的字段级 DataFlowEdge 实现参数流可视化

**Architecture:** 单文件改造（`nodes.tsx`）+ 布局高度微调（`layout.ts`）。数据流边和 Handle ID 逻辑完全复用现有实现，仅修改卡片 UI 结构和 Handle 视觉位置

**Tech Stack:** React 19, TypeScript, @xyflow/react (ReactFlow), CSS (Tailwind v4)

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `web/src/pages/workflow/nodes.tsx` | 修改 | 卡片结构重构，INPUT/OUTPUT list 渲染 |
| `web/src/pages/workflow/layout.ts` | 修改 | NODE_HEIGHT 适配新卡片高度 |
| `web/src/index.css` | 可能修改 | 新增 `.wf-input-row` / `.wf-output-row` 样式 |

---

### Task 1: 卡片主体结构改写

**Files:**
- Modify: `web/src/pages/workflow/nodes.tsx:154-242`

将 WorkflowNode 的 return JSX 从当前的"描述+预览+状态栏"结构改为"INPUT LIST + OUTPUT LIST"。

- [ ] **Step 1: 阅读当前 return 结构，定位改动区域**

阅读 `nodes.tsx` 第 154-242 行，确认当前渲染结构：标题栏（167-181）→ 描述+预览区（183-198）→ 状态栏（200-241）。

- [ ] **Step 2: 移除描述区、预览区和状态栏**

删除第 183-241 行（`{!isStart && (` 包裹的描述区、预览和状态栏）。保留 `// 入口` 注释行（第 141 行 `inputPoints` 定义）和 `// 出口` 注释行（第 148 行 `outputPoints` 定义）。

- [ ] **Step 3: 添加 INPUT LIST 区域（标题栏下方）**

在第 181 行标题栏 `</div>` 之后插入：

```tsx
      {/* INPUT LIST */}
      {!isStart && (
        <div
          className="wf-io-section"
          style={{
            borderBottom: inputPoints.length > 0 ? "1px solid var(--color-border-subtle)" : undefined,
          }}
        >
          <div className="wf-io-section-title" style={{ color: "#92400e" }}>
            INPUTS
          </div>
          {inputPoints.length === 0 ? (
            <div className="wf-io-empty">no inputs</div>
          ) : (
            inputPoints.map((param, i) => (
              <div key={param} className="wf-io-row" style={{ position: "relative" }}>
                <span className="wf-io-dot" style={{ background: "#f59e0b" }} />
                <span className="wf-io-label" style={{ color: "#92400e" }}>
                  {param}
                </span>
                <Handle
                  key={`in-${param}`}
                  type="target"
                  position={Position.Top}
                  id={`in-${param}`}
                  className="!w-2 !h-2 !border-2 !border-white !opacity-0"
                  style={{ background: "#f59e0b", left: 16, top: -4 - i * 22 }}
                />
              </div>
            ))
          )}
        </div>
      )}
```

**说明**：`top` 偏移根据行索引计算，每行约 22px 高。Handle 设为透明（`!opacity-0`），视觉圆点由 `.wf-io-dot` 自定义 div 提供。

- [ ] **Step 4: 添加 OUTPUT LIST 区域**

在 INPUT LIST 区域之后插入：

```tsx
      {/* OUTPUT LIST */}
      {!isStart ? (
        <div className="wf-io-section">
          <div className="wf-io-section-title" style={{ color: "#166534" }}>
            OUTPUTS
          </div>
          {outputPoints.length === 0 ? (
            <div className="wf-io-empty">no outputs</div>
          ) : (
            outputPoints.map((field, i) => (
              <div key={field} className="wf-io-row" style={{ position: "relative", opacity: 1 }}>
                <span className="wf-io-dot" style={{ background: "#22c55e" }} />
                <span className="wf-io-label" style={{ color: "#166534" }}>
                  {field}
                </span>
                <Handle
                  key={`out-${field}`}
                  type="source"
                  position={Position.Bottom}
                  id={`out-${field}`}
                  className="!w-2 !h-2 !border-2 !border-white !opacity-0"
                  style={{ background: "#22c55e", left: 16, bottom: -4 - (outputPoints.length - 1 - i) * 22 }}
                />
              </div>
            ))
          )}
        </div>
      ) : (
        /* start 节点的 outputs 列表 — 保持独立渲染不变 */
        outputPoints.map((field, i) => (
          <div key={field} className="wf-io-row" style={{ position: "relative" }}>
            <span className="wf-io-dot" style={{ background: "#22c55e" }} />
            <span className="wf-io-label" style={{ color: "#166534" }}>
              {field}
            </span>
            <Handle
              key={`out-${field}`}
              type="source"
              position={Position.Bottom}
              id={`out-${field}`}
              className="!w-2 !h-2 !border-2 !border-white !opacity-0"
              style={{ background: "#22c55e", left: 16, bottom: -4 - (outputPoints.length - 1 - i) * 22 }}
            />
          </div>
        ))
      )}
```

**说明**：非 start 节点用完整的 OUTPUT 区域包装。start 节点的 outputs 保持独立行渲染。`bottom` 偏移用 `(outputPoints.length - 1 - i)` 使 Handle 位置与行索引从下往上对应（ReactFlow Bottom Handle 从底部向上数）。

- [ ] **Step 5: 移除标签覆盖层（label overlay）**

删除第 272-292 行（入口标签覆盖层）和第 325-343 行（出口标签覆盖层）。这些覆盖层在新布局中不再需要，字段名已直接显示在 INPUT/OUTPUT 行内。

- [ ] **Step 6: 调整逻辑边 Handle 位置**

逻辑边 target Handle（第 261-271 行）和 source Handle（第 310-322 行）位置需重新计算：新卡片没有描述/状态区，Handle 应定位在卡片顶部和底部边缘。将逻辑边 Handle 移到各自区域的末尾（数据流 Handle 之后）：

逻辑边 target Handle 移到 input Handle 循环之后（仍在 `{!isStart &&` 块内）：

```tsx
      {/* 逻辑边 target Handle — 排在数据流入口后面 */}
      {!isStart && (
        <Handle
          type="target"
          position={Position.Top}
          className="!w-2 !h-2 !border-2 !border-white"
          style={{
            background: colors.main,
            left: inputPoints.length === 0 ? "50%" : `${16 + inputPoints.length * 22 - 8}px`,
            top: -4,
          }}
        />
      )}
```

逻辑边 source Handle 移到 output Handle 循环之后：

```tsx
      {/* 逻辑边 source Handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !border-2 !border-white"
        style={{
          background: colors.main,
          left: outputPoints.length === 0 ? "50%" : `${16 + outputPoints.length * 22 - 8}px`,
          bottom: -4,
        }}
      />
```

- [ ] **Step 7: 运行 `bun run build:web` 验证构建**

预期：构建成功，无 TS 类型错误。

- [ ] **Step 8: 提交**

```bash
git add web/src/pages/workflow/nodes.tsx
git commit -m "refactor(workflow): redesign WorkflowNode card with INPUT/OUTPUT lists"
```

---

### Task 2: 添加 IO 区域 CSS 样式

**Files:**
- Modify: `web/src/index.css`

- [ ] **Step 1: 在 `web/src/index.css` 末尾添加样式**

```css
/* 工作流节点 INPUT/OUTPUT 区域 */
.wf-io-section {
  padding: 4px 8px;
  min-width: 160px;
}

.wf-io-section-title {
  font-size: 8px;
  font-weight: 700;
  margin-bottom: 3px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  text-align: left;
}

.wf-io-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
  font-size: 10px;
}

.wf-io-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px currentColor;
  flex-shrink: 0;
}

.wf-io-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wf-io-empty {
  font-size: 9px;
  color: var(--color-text-muted);
  text-align: center;
  padding: 2px 0;
}
```

- [ ] **Step 2: 运行 `bun run build:web` 验证构建**

- [ ] **Step 3: 提交**

```bash
git add web/src/index.css
git commit -m "style(workflow): add IO section styles for WorkflowNode card"
```

---

### Task 3: 更新布局高度常量

**Files:**
- Modify: `web/src/pages/workflow/layout.ts:5`

- [ ] **Step 1: 调整 NODE_HEIGHT 常量**

新卡片没有描述/状态区，但增加了 INPUT/OUTPUT 列表。估算高度：
- 标题栏：~28px
- INPUT 区域（含标题 + 2-3 行参数）：~66px
- OUTPUT 区域（含标题 + 1-3 行字段）：~66px
- 总计约 160px，取安全值 180px

将第 5 行：
```typescript
const NODE_HEIGHT = 72;
```
改为：
```typescript
const NODE_HEIGHT = 180;
```

- [ ] **Step 2: 运行 `bun run build:web` 验证构建**

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/workflow/layout.ts
git commit -m "refactor(workflow): increase NODE_HEIGHT to 180 for new card layout"
```

---

### Task 4: precheck + 最终验证

- [ ] **Step 1: 运行 precheck**

```bash
bun run precheck
```

预期：tsc + biome check + 测试全部通过。

- [ ] **Step 2: 如有 biome format 自动修复，提交**

```bash
git add -u
git commit -m "chore: precheck auto-fixes for workflow card redesign"
```
