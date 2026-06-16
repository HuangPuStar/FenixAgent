# Sidebar Footer 样式重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将侧栏底部账号+组织区域的独立色块合并为统一半透明面板，与深蓝侧栏背景视觉融合。

**Architecture:** 纯 CSS 重构 + 轻微 JSX 结构调整。在 `user-panel` 内新增一个 `.agent-sidebar-footer-card` 包裹用户行和组织行，移除旧的独立色块样式，替换为统一暗色圆角面板，两行等高且 icon 槽对齐。

**Tech Stack:** CSS, React TSX

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `web/src/pages/agent-panel/agent-panel.css` | sidebar footer 区域样式 | 修改 |
| `web/src/pages/agent-panel/AgentSidebar.tsx` | sidebar 底部 JSX 结构 | 修改 |

---

### Task 1: 修改 AgentSidebar.tsx —— 新增 footer-card 包裹结构

**Files:**
- Modify: `web/src/pages/agent-panel/AgentSidebar.tsx:109-184`

在 `agent-sidebar-user-panel` 内，用一个新 div（`.agent-sidebar-footer-card`）包裹用户按钮和组织行，使其成为一个整体卡片。

将第 110-184 行的 footer 区域替换为：

```tsx
      {/* 底部：用户 + 组织 */}
      <div className="agent-sidebar-footer border-t border-border-subtle">
        <div ref={userMenuRef} className="agent-sidebar-user-panel relative">
          {userMenuOpen && (
            <div className="agent-sidebar-user-menu absolute rounded-[var(--radius-lg)] shadow-lg shadow-black/10 z-50">
              <div className="agent-sidebar-user-menu-section">
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    setChangePasswordOpen(true);
                  }}
                  className="agent-sidebar-user-menu-item"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {tSidebar("personalSettings", { defaultValue: "个人设置" })}
                </button>
                <button type="button" onClick={handleLogout} className="agent-sidebar-user-menu-item danger">
                  <LogOut className="w-3.5 h-3.5" />
                  {tSidebar("logout")}
                </button>
              </div>
            </div>
          )}

          {orgMenuOpen && (
            <div className="agent-sidebar-org-menu absolute rounded-[var(--radius-lg)] shadow-lg shadow-black/10 z-50">
              <div className="agent-sidebar-user-menu-section orgs">
                {orgs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void handleSwitchOrg(item.id)}
                    className={["agent-sidebar-user-menu-item", item.id === org?.id ? "active" : ""].join(" ")}
                  >
                    <Building2 className="w-3.5 h-3.5" />
                    <span className="truncate">{item.name}</span>
                    {item.id === org?.id && <Check className="ml-auto w-3.5 h-3.5" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 统一底部卡片 */}
          <div className="agent-sidebar-footer-card">
            <button
              type="button"
              onClick={() => {
                setOrgMenuOpen(false);
                setUserMenuOpen((v) => !v);
              }}
              className="agent-sidebar-user-button"
            >
              <div className="agent-sidebar-avatar-slot">
                <div className="agent-sidebar-avatar">
                  <UserRound className="w-4 h-4" />
                </div>
              </div>
              <span className="agent-sidebar-user-name truncate">{userName}</span>
              <ChevronRight className="agent-sidebar-user-chevron w-3.5 h-3.5" />
            </button>

            {org && (
              <button
                type="button"
                className="agent-sidebar-org-row"
                onClick={() => {
                  setUserMenuOpen(false);
                  setOrgMenuOpen((v) => !v);
                }}
              >
                <div className="agent-sidebar-org-icon-wrap">
                  <Building2 className="agent-sidebar-org-icon w-4 h-4" />
                </div>
                <span className="agent-sidebar-org-name truncate">{org.name}</span>
                <ChevronRight className="agent-sidebar-org-chevron w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
```

**关键变更说明：**
- 移除旧的 `.agent-sidebar-user` wrapper div
- 新增 `.agent-sidebar-footer-card` 包裹用户按钮和组织行，使其成为统一卡片
- 组织行 icon 外包一层 `.agent-sidebar-org-icon-wrap`，用于实现与用户 avatar 等宽的 icon 槽（32px）

- [ ] 按上述代码替换 `AgentSidebar.tsx:109-184` 的 footer 区域

---

### Task 2: 修改 agent-panel.css —— 重写 footer 卡片样式

**Files:**
- Modify: `web/src/pages/agent-panel/agent-panel.css`

#### 2.1 删除旧样式块

删除第 397-501 行，替换为新的 footer 卡片样式：

```css
/* ---------- sidebar footer 卡片 ---------- */
.agent-sidebar-footer {
  flex-shrink: 0;
  background: transparent;
}

.agent-sidebar-user-panel {
  overflow: visible;
  padding: 12px 10px;
}

/* 统一底部卡片：半透明暗色面板包裹用户行 + 组织行 */
.agent-sidebar-footer-card {
  background: rgba(255, 255, 255, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 10px;
  overflow: hidden;
}

/* 用户行 */
.agent-sidebar-user-button {
  display: flex;
  width: 100%;
  align-items: center;
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: transparent;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.agent-sidebar-user-button:hover {
  background: rgba(255, 255, 255, 0.06);
}

/* 组织行 */
.agent-sidebar-org-row {
  display: flex;
  width: 100%;
  align-items: center;
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
  font-weight: 400;
  cursor: pointer;
  transition: background 0.15s;
}

.agent-sidebar-org-row:hover {
  background: rgba(255, 255, 255, 0.06);
}

/* 头像槽：固定 32px 宽，头像 26px 居中，与组织 icon 槽左对齐 */
.agent-sidebar-avatar-slot {
  width: 32px;
  height: 26px;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}

.agent-sidebar-avatar {
  display: flex;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: linear-gradient(135deg, #6be6ff, #0f6bff);
  color: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18);
}

/* 组织 icon 槽：与用户行头像槽等宽 (32px)，icon 16px 居中 */
.agent-sidebar-org-icon-wrap {
  width: 32px;
  height: 26px;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}

.agent-sidebar-org-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.45);
}

/* 用户名 */
.agent-sidebar-user-name {
  flex: 1;
  min-width: 0;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  padding-left: 10px;
}

/* 组织名 */
.agent-sidebar-org-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 11px;
  font-weight: 400;
  padding-left: 10px;
}

/* chevron */
.agent-sidebar-user-chevron,
.agent-sidebar-org-chevron {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: rgba(255, 255, 255, 0.3);
  stroke-width: 2.2;
}

/* popup 弹窗：保持白色底原样，仅微调与卡片的间距 */
.agent-sidebar-user-menu {
  left: calc(100% + 10px);
  bottom: 24px;
  width: 192px;
  max-height: min(240px, calc(100dvh - 24px));
  overflow-y: auto;
  color: #253452;
}

.agent-sidebar-org-menu {
  left: calc(100% + 10px);
  bottom: 0;
  width: 224px;
  max-height: min(260px, calc(100dvh - 24px));
  overflow-y: auto;
  color: #253452;
}

.agent-sidebar-user-menu-section {
  overflow: hidden;
  padding: 8px;
  border: 1px solid rgba(196, 219, 242, 0.82);
  border-radius: 2px;
  background: rgba(235, 248, 255, 0.96);
  box-shadow: 0 8px 24px rgba(10, 36, 82, 0.12);
}

.agent-sidebar-user-menu-section.orgs {
  max-height: 240px;
  overflow-y: auto;
}

.agent-sidebar-user-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: #4f607b;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}

.agent-sidebar-user-menu-item:hover,
.agent-sidebar-user-menu-item.active {
  background: rgba(255, 255, 255, 0.72);
  color: #0f6bff;
}

.agent-sidebar-user-menu-item.danger {
  color: #f04438;
}

.agent-sidebar-user-menu button {
  white-space: nowrap;
}
```

#### 2.2 更新 collapsed 状态样式

将第 597-615 行的 collapsed footer 样式替换为：

```css
.agent-sidebar.collapsed .agent-sidebar-footer {
  padding: 8px 10px 12px;
}

.agent-sidebar.collapsed .agent-sidebar-user-panel {
  padding: 0;
}

.agent-sidebar.collapsed .agent-sidebar-footer-card {
  background: rgba(255, 255, 255, 0.10);
}

.agent-sidebar.collapsed .agent-sidebar-user-button {
  justify-content: center;
  min-height: 48px;
  padding: 0;
  border-bottom: none;
  background: transparent;
}

.agent-sidebar.collapsed .agent-sidebar-user-menu {
  width: 224px;
  min-width: 224px;
}

.agent-sidebar.collapsed .agent-sidebar-org-menu {
  display: none;
}
```

注意：之前第 568 行有 `.agent-sidebar.collapsed .agent-sidebar-org-row` 的 `display: none`，这行 CSS 选择器在第 565 行的逗号列表末尾。需确认 collapsed 时组织行仍隐藏（因为整体卡片中组织行占空间）。改为让整个 `.agent-sidebar-org-row` 在 collapsed 下 `display: none`：

在 `.agent-sidebar.collapsed .agent-sidebar-user-button` 下方追加：

```css
.agent-sidebar.collapsed .agent-sidebar-org-row {
  display: none;
}
```

#### 2.3 更新 sidebar collapsed 时隐藏元素列表

将第 565 行附近的多选器中的 `.agent-sidebar-org-row` 移除（因为它会被下面的新规则覆盖）。原来的行：

```css
.agent-sidebar.collapsed .agent-sidebar-org-row {
  display: none;
}
```

已存在于第 568 行。保持该行不动即可。

#### 2.4 还需确认 `.agent-sidebar-user` 相关样式是否被其他组件引用

第 260 行的 `.agent-sidebar-footer, .agent-sidebar-user` 需要移除 `.agent-sidebar-user`（因为我们已经删除了该元素）。改为：

```css
.agent-sidebar-tree-wrap,
.agent-sidebar-more,
.agent-sidebar-footer {
  border-color: rgba(255, 255, 255, 0.1);
}
```

```css
.agent-sidebar-user {
  /* 已废弃，移除 */
}
```
→ 直接删除 `.agent-sidebar-user` 这个选择器。

- [ ] 按上述修改替换 `agent-panel.css` 中 footer 相关样式

---

### Task 3: 验证构建和视觉

- [ ] 运行 `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`

  预期：TypeScript 编译通过，Vite 构建成功无错误。

---

### Task 4: Commit

- [ ] 提交代码

```bash
git add web/src/pages/agent-panel/agent-panel.css web/src/pages/agent-panel/AgentSidebar.tsx
git commit -m "fix(ui): refactor sidebar footer into unified dark panel

Merge user row and org row into a single semi-transparent card matching
the sidebar's dark gradient. Equal row heights, aligned icon slots,
transparent background with subtle dividers.

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-worst.best>"
```
