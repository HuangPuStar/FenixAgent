# Provider-Model 合并 人工验收清单

**生成时间:** 2026-04-25
**关联计划:** spec-plan.md
**关联设计:** spec-design.md

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 运行时: `bun --version`
- [ ] [AUTO] 编译项目: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
- [ ] [AUTO/SERVICE] 启动开发服务: `bun run dev:web` (port: 5173)

### 测试数据准备
- [ ] 至少存在一个已配置的服务商（可通过 UI 新建或 API 创建）

---

## 验收项目

### 场景 1: 构建与自动化测试

#### - [ ] 1.1 运行完整测试套件
- **来源:** spec-plan.md Task 6 检查1
- **目的:** 确保所有自动化测试通过无回归
- **操作步骤:**
  1. [A] `bun test web/src/__tests__/ 2>&1 | tail -10` → 期望包含: `pass` 且无 `fail`

#### - [ ] 1.2 前端构建无错误
- **来源:** spec-plan.md Task 6 检查2
- **目的:** 确认 TypeScript 编译和 Vite 构建成功
- **操作步骤:**
  1. [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5` → 期望包含: `built in`

---

### 场景 2: DataTable 扩展属性

#### - [ ] 2.1 DataTableProps 包含 defaultExpandAll 且导出函数存在
- **来源:** spec-plan.md Task 1 检查1-2
- **目的:** 确认接口定义和运行时逻辑完整
- **操作步骤:**
  1. [A] `grep -c "defaultExpandAll" web/components/config/DataTable.tsx` → 期望包含: `3`（接口定义 + 参数解构 + 初始化逻辑，≥3 即可）
  2. [A] `grep -n "export function buildInitialExpandedState" web/components/config/DataTable.tsx` → 期望包含: `export function buildInitialExpandedState`

#### - [ ] 2.2 DataTable 单元测试通过
- **来源:** spec-plan.md Task 1 检查3
- **目的:** 验证 defaultExpandAll 逻辑测试
- **操作步骤:**
  1. [A] `bun test web/src/__tests__/config-datatable.test.ts 2>&1 | tail -5` → 期望包含: `pass` 且无 `fail`

---

### 场景 3: ModelConfigDialog 组件

#### - [ ] 3.1 ModelConfigDialog 导出与依赖正确
- **来源:** spec-plan.md Task 2 检查1-3
- **目的:** 确认组件、纯函数和图标正确导出引入
- **操作步骤:**
  1. [A] `grep -n "export function ModelConfigDialog" web/components/config/ModelConfigDialog.tsx` → 期望包含: `export function ModelConfigDialog`
  2. [A] `grep -n "export function buildModelOptions" web/components/config/ModelConfigDialog.tsx` → 期望包含: `export function buildModelOptions`
  3. [A] `grep -c "Settings" web/components/config/ModelConfigDialog.tsx` → 期望包含: ≥2（import + JSX 使用）

#### - [ ] 3.2 ModelConfigDialog 测试通过
- **来源:** spec-plan.md Task 2 检查4
- **目的:** 验证 buildModelOptions 纯函数测试
- **操作步骤:**
  1. [A] `bun test web/src/__tests__/config-model-config-dialog.test.ts 2>&1 | tail -5` → 期望包含: `pass` 且无 `fail`

---

### 场景 4: ModelsPage 合并完整性

#### - [ ] 4.1 ModelsPage 导出所有必要函数
- **来源:** spec-plan.md Task 3 检查1 + Task 6 检查5
- **目的:** 确认迁移函数全部导出
- **操作步骤:**
  1. [A] `grep -n "export function" web/src/pages/ModelsPage.tsx` → 期望包含: `getModelUsageStatus`, `validateProviderForm`, `buildProviderPayload`, `ModelsPage` 四个导出

#### - [ ] 4.2 ModelConfigDialog 和 defaultExpandAll 被正确引用
- **来源:** spec-plan.md Task 3 检查2-3
- **目的:** 确认新组件和属性在 ModelsPage 中使用
- **操作步骤:**
  1. [A] `grep -n "ModelConfigDialog" web/src/pages/ModelsPage.tsx` → 期望包含: import 声明和 JSX 使用
  2. [A] `grep -n "defaultExpandAll" web/src/pages/ModelsPage.tsx` → 期望包含: DataTable props

#### - [ ] 4.3 测试导入路径更新且测试通过
- **来源:** spec-plan.md Task 3 检查4-5
- **目的:** 确认迁移后测试正确引用 ModelsPage
- **操作步骤:**
  1. [A] `grep "from.*ModelsPage" web/src/__tests__/config-providers-page.test.ts` → 期望包含: `"../pages/ModelsPage"`
  2. [A] `bun test web/src/__tests__/config-models-page.test.ts web/src/__tests__/config-providers-page.test.ts 2>&1 | tail -5` → 期望包含: `pass` 且无 `fail`

---

### 场景 5: 路由与侧边栏清理

#### - [ ] 5.1 App.tsx 无 providers 残留
- **来源:** spec-plan.md Task 4 检查1-3 + Task 6 检查3
- **目的:** 确认路由和侧边栏完全清理
- **操作步骤:**
  1. [A] `grep -n "ProvidersPage" web/src/App.tsx` → 期望精确:（空，无匹配）
  2. [A] `grep -n "Cloud" web/src/App.tsx` → 期望精确:（空，无匹配）
  3. [A] `grep -n "providers" web/src/App.tsx` → 期望精确:（空，无匹配）

#### - [ ] 5.2 /code/providers 路由不可访问
- **来源:** spec-plan.md Task 4 检查4 + Task 6 检查4
- **目的:** 确认 providers 路由已移除
- **操作步骤:**
  1. [A] `bun test web/src/__tests__/config-routing.test.ts 2>&1 | tail -5` → 期望包含: `pass` 且无 `fail`
  2. [A] `grep "null.*已移除" web/src/__tests__/config-routing.test.ts` → 期望包含: `null`

---

### 场景 6: ProvidersPage 文件清理

#### - [ ] 6.1 ProvidersPage.tsx 已删除且无残留引用
- **来源:** spec-plan.md Task 5 检查1-3 + Task 6 检查7-8
- **目的:** 确认废弃文件已删除、无残留引用
- **操作步骤:**
  1. [A] `ls web/src/pages/ProvidersPage.tsx 2>&1` → 期望包含: `No such file`
  2. [A] `grep -rn "ProvidersPage" web/src/ --include="*.ts" --include="*.tsx"` → 期望精确:（空，无匹配）

---

### 场景 7: UI 交互验证

#### - [ ] 7.1 访问 /code/models 显示合并后的模型管理页面
- **来源:** spec-design.md 验收标准
- **目的:** 确认合并后页面正确渲染
- **操作步骤:**
  1. [H] 打开 `http://localhost:5173/code/models`，页面标题为"模型管理"，包含服务商列表 → 是/否

#### - [ ] 7.2 侧边栏只显示"模型"入口
- **来源:** spec-design.md 验收标准
- **目的:** 确认"服务商"侧边栏入口已移除
- **操作步骤:**
  1. [H] 查看侧边栏 Settings 区域，只有"模型"入口，无"服务商"入口 → 是/否

#### - [ ] 7.3 服务商行默认展开显示模型子表格
- **来源:** spec-design.md 验收标准 + spec-plan.md Task 1
- **目的:** 确认 defaultExpandAll 功能生效
- **操作步骤:**
  1. [H] 打开模型页面，所有服务商行下方自动展示模型子表格（无需手动点击展开） → 是/否

#### - [ ] 7.4 点击齿轮 icon 弹出模型配置 Dialog
- **来源:** spec-design.md 验收标准
- **目的:** 确认 ModelConfigDialog 交互正常
- **操作步骤:**
  1. [H] 点击标题栏齿轮 icon，弹出"模型配置" Dialog，包含主模型和轻量模型 Select → 是/否

#### - [ ] 7.5 切换主模型和轻量模型即时保存
- **来源:** spec-design.md 验收标准
- **目的:** 确认模型配置即时保存功能
- **操作步骤:**
  1. [H] 在 Dialog 中切换主模型 Select，观察是否出现 Toast 提示"模型已更新" → 是/否

#### - [ ] 7.6 服务商的新建、编辑、删除功能正常
- **来源:** spec-design.md 验收标准
- **目的:** 确认服务商 CRUD 操作
- **操作步骤:**
  1. [H] 点击"新建服务商"，填写表单并提交，新服务商出现在列表中 → 是/否
  2. [H] 点击服务商行"编辑"按钮，修改信息并保存，变更生效 → 是/否
  3. [H] 点击服务商行"删除"按钮，确认删除，服务商从列表中移除 → 是/否

#### - [ ] 7.7 模型的新增、编辑、删除功能正常
- **来源:** spec-design.md 验收标准
- **目的:** 确认模型 CRUD 操作
- **操作步骤:**
  1. [H] 展开某服务商，点击"+ 新增模型"，填写模型信息并保存 → 是/否
  2. [H] 在模型子表格中点击"编辑"，修改模型信息并保存 → 是/否
  3. [H] 在模型子表格中点击"删除"，确认删除，模型从列表中移除 → 是/否

#### - [ ] 7.8 搜索、筛选、排序功能正常
- **来源:** spec-design.md 验收标准
- **目的:** 确认 DataTable 基础交互功能
- **操作步骤:**
  1. [H] 在搜索框输入服务商名称，列表正确过滤 → 是/否
  2. [H] 点击列头排序，列表按该列排序 → 是/否

---

## 验收后清理

- [ ] [AUTO] 终止后台服务 dev:web: `kill $PID`（对应准备阶段启动的服务，PID 在执行时填入）

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | 运行完整测试套件 | 1 | 0 | ⬜ |
| 场景 1 | 1.2 | 前端构建无错误 | 1 | 0 | ⬜ |
| 场景 2 | 2.1 | DataTableProps 含 defaultExpandAll | 2 | 0 | ⬜ |
| 场景 2 | 2.2 | DataTable 单元测试通过 | 1 | 0 | ⬜ |
| 场景 3 | 3.1 | ModelConfigDialog 导出与依赖 | 3 | 0 | ⬜ |
| 场景 3 | 3.2 | ModelConfigDialog 测试通过 | 1 | 0 | ⬜ |
| 场景 4 | 4.1 | ModelsPage 导出必要函数 | 1 | 0 | ⬜ |
| 场景 4 | 4.2 | ModelConfigDialog/defaultExpandAll 引用 | 2 | 0 | ⬜ |
| 场景 4 | 4.3 | 测试导入路径更新且通过 | 2 | 0 | ⬜ |
| 场景 5 | 5.1 | App.tsx 无 providers 残留 | 3 | 0 | ⬜ |
| 场景 5 | 5.2 | /code/providers 路由不可访问 | 2 | 0 | ⬜ |
| 场景 6 | 6.1 | ProvidersPage 已删除无残留 | 2 | 0 | ⬜ |
| 场景 7 | 7.1 | 合并后页面正确渲染 | 0 | 1 | ⬜ |
| 场景 7 | 7.2 | 侧边栏只显示"模型"入口 | 0 | 1 | ⬜ |
| 场景 7 | 7.3 | 服务商行默认展开 | 0 | 1 | ⬜ |
| 场景 7 | 7.4 | 齿轮 icon 弹出 Dialog | 0 | 1 | ⬜ |
| 场景 7 | 7.5 | 切换模型即时保存 | 0 | 1 | ⬜ |
| 场景 7 | 7.6 | 服务商 CRUD 功能 | 0 | 3 | ⬜ |
| 场景 7 | 7.7 | 模型 CRUD 功能 | 0 | 3 | ⬜ |
| 场景 7 | 7.8 | 搜索筛选排序功能 | 0 | 2 | ⬜ |

**验收结论:** ⬜ 全部通过 / ⬜ 存在问题
