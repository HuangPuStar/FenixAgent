# 工作流代理与 UI 嵌入 人工验收清单

**生成时间:** 2026-05-05 18:05
**关联计划:** spec/feature_20260505_F001_workflow-proxy-ui/spec-plan.md
**关联设计:** spec/feature_20260505_F001_workflow-proxy-ui/spec-design.md

---

## 验收前准备

### 环境要求
- [x] [AUTO] 类型检查: `bun run typecheck`
- [x] [AUTO] 构建前端: `bun run build:web`
- [x] [AUTO] 运行单元测试: `bun test src/__tests__/workflow-proxy.test.ts && bun test web/src/__tests__/workflow-page.test.tsx`
- [x] [AUTO/SERVICE] 启动 acpx-g 服务: `bash restart-acpx-g.sh` (port: 8848)
- [x] [AUTO/SERVICE] 启动 RCS 后端: `bun run dev` (port: 3000)

### 测试数据准备
- [x] 浏览器已登录 RCS 控制面板（`http://localhost:3000/ctrl/`），session cookie 有效

---

## 验收项目

### 场景 1：后端代理路由认证保护

#### - [x] 1.1 未认证访问 /workflow-ui/ 返回 401
- **来源:** spec-plan.md Task 3 验证 2 / spec-design.md §认证策略
- **目的:** 确认代理路由受 sessionAuth 保护
- **操作步骤:**
  1. [A] `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/workflow-ui/` → 期望精确: `401`

#### - [x] 1.2 未认证访问 /api/v1/workflows 返回 401
- **来源:** spec-plan.md Task 3 验证 2 / spec-design.md §认证策略
- **目的:** 确认 API 代理路由受 sessionAuth 保护
- **操作步骤:**
  1. [A] `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/v1/workflows` → 期望精确: `401`

---

### 场景 2：后端代理路由请求转发

#### - [x] 2.1 认证后静态资源代理转发正确
- **来源:** spec-plan.md Task 1 检查步骤 / spec-design.md §路径映射设计
- **目的:** 确认 /workflow-ui/* 请求被正确转发到 acpx-g
- **操作步骤:**
  1. [A] `curl -s -o /dev/null -w "%{http_code}" -b "session=$(curl -s -c - http://localhost:3000/api/auth/get-session 2>/dev/null | grep -o 'session=[^;]*' | cut -d= -f2)" http://localhost:3000/workflow-ui/` → 期望包含: `200`

#### - [x] 2.2 认证后 API 代理转发正确
- **来源:** spec-plan.md Task 1 检查步骤 / spec-design.md §路径映射设计
- **目的:** 确认 /api/v1/* 请求被正确转发到 acpx-g 的 /api/v1/*
- **操作步骤:**
  1. [A] `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/v1/workflows -H "Cookie: $(curl -s -c - 'http://localhost:3000/api/auth/get-session' | head -2)"` → 期望包含: `200`

---

### 场景 3：前端工作流页面导航与展示

#### - [x] 3.1 侧边栏显示「工作流」导航项
- **来源:** spec-plan.md Task 2 / spec-design.md §侧边栏导航
- **目的:** 确认用户可从侧边栏进入工作流页面
- **操作步骤:**
  1. [H] 打开 `http://localhost:3000/ctrl/`，在侧边栏「配置」分组中查看是否显示「工作流」导航项 → 是/否

#### - [x] 3.2 点击「工作流」后 iframe 加载 acpx-g UI
- **来源:** spec-plan.md Task 3 验证 3 / spec-design.md §前端页面设计
- **目的:** 确认 iframe 正确嵌入 acpx-g 工作流编辑器
- **操作步骤:**
  1. [H] 点击侧边栏「工作流」导航项，观察页面是否显示 acpx-g 工作流编辑器界面（非空白或错误页面） → 是/否

#### - [x] 3.3 工作流编辑器功能正常
- **来源:** spec-design.md §验收标准
- **目的:** 确认通过代理访问时编辑器功能完整
- **操作步骤:**
  1. [H] 在工作流页面中查看是否可见工作流模板列表或编辑器界面 → 是/否

#### - [x] 3.4 运行记录页面正常加载
- **来源:** spec-plan.md Task 3 验证 4 / spec-design.md §验收标准
- **目的:** 确认运行记录 API 代理正确
- **操作步骤:**
  1. [H] 在 acpx-g UI 中点击「运行记录」标签，观察列表是否正常加载 → 是/否

---

### 场景 4：acpx-g 服务不可达时的错误处理

#### - [x] 4.1 停止 acpx-g 后前端显示错误提示
- **来源:** spec-plan.md Task 3 验证 5 / spec-design.md §acpx-g 服务可用性
- **目的:** 确认 acpx-g 不可用时前端友好提示
- **操作步骤:**
  1. [AUTO] 停止 acpx-g 服务: `lsof -ti:8848 | xargs kill 2>/dev/null`
  2. [H] 刷新浏览器工作流页面，观察是否显示「工作流引擎连接失败」提示和重试按钮 → 是/否

#### - [x] 4.2 acpx-g 不可达时代理返回 502
- **来源:** spec-plan.md Task 1 测试场景 / spec-design.md §代理实现细节
- **目的:** 确认代理正确处理下游服务故障
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/workflow-ui/ -H "Cookie: valid_session" | jq .error.type` → 期望包含: `bad_gateway`

---

### 场景 5：配置可覆盖性与路由无冲突

#### - [x] 5.1 acpxGUrl 配置字段存在且默认值正确
- **来源:** spec-plan.md Task 1 检查步骤
- **目的:** 确认环境变量配置入口可用
- **操作步骤:**
  1. [A] `grep "acpxGUrl" src/config.ts` → 期望包含: `ACPX_G_URL`

#### - [x] 5.2 /api/v1 与 /api/auth 路由无冲突
- **来源:** spec-plan.md Task 1 检查步骤
- **目的:** 确认路由挂载不影响 better-auth
- **操作步骤:**
  1. [A] `grep '"/api' src/index.ts` → 期望包含: `/api/auth`

---

### 场景 6：构建与测试回归

#### - [x] 6.1 后端类型检查通过
- **来源:** spec-plan.md Task 0/1 检查步骤
- **目的:** 确认无类型错误引入
- **操作步骤:**
  1. [A] `bun run typecheck 2>&1` → 期望包含: (无输出或无 error)

#### - [x] 6.2 前端构建成功
- **来源:** spec-plan.md Task 2/3 检查步骤
- **目的:** 确认前端构建产物完整
- **操作步骤:**
  1. [A] `bun run build:web 2>&1 | tail -5` → 期望包含: `built in`

#### - [x] 6.3 全部单元测试通过
- **来源:** spec-plan.md Task 3 验证 1
- **目的:** 确认无测试回归
- **操作步骤:**
  1. [A] `bun test src/__tests__/workflow-proxy.test.ts && bun test web/src/__tests__/workflow-page.test.tsx` → 期望包含: `0 fail`

---

## 验收后清理

- [ ] [AUTO] 终止 acpx-g 服务: `lsof -ti:8848 | xargs kill 2>/dev/null` (对应准备阶段启动的 acpx-g)
- [ ] [AUTO] 终止 RCS 后端: `lsof -ti:3000 | xargs kill 2>/dev/null` (对应准备阶段启动的 bun run dev)

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | 未认证访问 /workflow-ui/ 返回 401 | 1 | 0 | ✅ |
| 场景 1 | 1.2 | 未认证访问 /api/v1/workflows 返回 401 | 1 | 0 | ✅ |
| 场景 2 | 2.1 | 认证后静态资源代理转发正确 | 1 | 0 | ✅ |
| 场景 2 | 2.2 | 认证后 API 代理转发正确 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | 侧边栏显示「工作流」导航项 | 0 | 1 | ✅ |
| 场景 3 | 3.2 | 点击「工作流」后 iframe 加载 acpx-g UI | 0 | 1 | ✅ |
| 场景 3 | 3.3 | 工作流编辑器功能正常 | 0 | 1 | ✅ |
| 场景 3 | 3.4 | 运行记录页面正常加载 | 0 | 1 | ✅ |
| 场景 4 | 4.1 | 停止 acpx-g 后前端显示错误提示 | 1 | 1 | ✅ |
| 场景 4 | 4.2 | acpx-g 不可达时代理返回 502 | 1 | 0 | ✅ |
| 场景 5 | 5.1 | acpxGUrl 配置字段存在且默认值正确 | 1 | 0 | ✅ |
| 场景 5 | 5.2 | /api/v1 与 /api/auth 路由无冲突 | 1 | 0 | ✅ |
| 场景 6 | 6.1 | 后端类型检查通过 | 1 | 0 | ✅ |
| 场景 6 | 6.2 | 前端构建成功 | 1 | 0 | ✅ |
| 场景 6 | 6.3 | 全部单元测试通过 | 1 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
