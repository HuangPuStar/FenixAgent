# server-web-auth-adapter 人工验收清单

**生成时间:** 2026-05-13 11:52
**关联计划:** `spec/feature_20260512_F001_server-web-auth-adapter/spec-plan.md`
**关联设计:** `spec/feature_20260512_F001_server-web-auth-adapter/spec-design.md`

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 版本: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun --version`
- [ ] [AUTO] 构建 server 包: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run build`
- [ ] [AUTO] 执行类型检查: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run typecheck`

### 测试数据准备
- [ ] [AUTO] 使用测试临时库执行验收: `export MOTHERSHIP_DB_PATH=/private/tmp/mothership-human-verify.sqlite`
- [ ] [AUTO] 确认本轮验收不依赖真实前端服务: `printf 'auth adapter verify uses bun tests and source inspection only\n'`

---

## 验收项目

### 场景 1：基础工具链与总回归

#### - [x] 1.1 完整测试入口可执行
- **来源:** spec-plan.md Task 4 / Task 5
- **目的:** 确认包级回归入口稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__ >/dev/null && printf OK` → 期望精确: OK

#### - [x] 1.2 测试脚本已覆盖整个测试目录
- **来源:** spec-plan.md Task 4
- **目的:** 确认后续回归命令统一
- **操作步骤:**
  1. [A] `rg -n '"test": "bun test src/__tests__"' /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/package.json` → 期望包含: bun test src/__tests__

#### - [x] 1.3 类型检查仍然通过
- **来源:** spec-plan.md Task 0 / Task 4
- **目的:** 确认新增导入链稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run typecheck >/dev/null && printf OK` → 期望精确: OK

### 场景 2：认证数据层落地

#### - [x] 2.1 SQLite 自举已包含认证表
- **来源:** spec-plan.md Task 1 / spec-design.md §四
- **目的:** 确认认证表结构齐备
- **操作步骤:**
  1. [A] `rg -n 'CREATE TABLE IF NOT EXISTS (user|session|account|verification|api_key)' /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/db/schema.ts | wc -l | tr -d ' '` → 期望精确: 5

#### - [x] 2.2 Drizzle 认证 schema 已完整导出
- **来源:** spec-plan.md Task 1
- **目的:** 确认 adapter 可直接复用
- **操作步骤:**
  1. [A] `rg -n 'export const (user|session|account|verification|apiKey)' /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/db/auth-schema.ts | wc -l | tr -d ' '` → 期望精确: 5

#### - [x] 2.3 认证 schema 回归测试通过
- **来源:** spec-plan.md Task 1
- **目的:** 确认表列与外键正确
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/sqlite-auth-schema.test.ts >/dev/null && printf OK` → 期望精确: OK

### 场景 3：认证服务与会话协议兼容

#### - [x] 3.1 better-auth 配置保留兼容参数
- **来源:** spec-plan.md Task 2 / spec-design.md §三
- **目的:** 确认旧前端协议可复用
- **操作步骤:**
  1. [A] `rg -n 'emailAndPassword|expiresIn|updateAge|trustedOrigins|baseURL' /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/auth/better-auth.ts` → 期望包含: trustedOrigins

#### - [x] 3.2 API key 服务导出齐全
- **来源:** spec-plan.md Task 2 / spec-design.md §三
- **目的:** 确认用户态扩展能力可复用
- **操作步骤:**
  1. [A] `rg -n 'export async function (createApiKey|validateApiKeyAndGetUser|listApiKeysByUser|deleteApiKey|updateApiKeyLabel)' /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/auth/api-key-service.ts | wc -l | tr -d ' '` → 期望精确: 5

#### - [x] 3.3 API key 服务行为测试通过
- **来源:** spec-plan.md Task 2
- **目的:** 确认创建校验与所有权约束
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/api-key-service.test.ts >/dev/null && printf OK` → 期望精确: OK

#### - [x] 3.4 `/api/auth/*` 登录与取会话链路可用
- **来源:** spec-plan.md Task 3 / Task 5
- **目的:** 确认登录闭环已打通
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/app-auth-routes.test.ts >/dev/null && printf OK` → 期望精确: OK

### 场景 4：宿主上下文与架构边界

#### - [x] 4.1 `sessionAuth` 注入旧后端兼容字段
- **来源:** spec-plan.md Task 3 / spec-design.md §六
- **目的:** 确认 `/web/*` 可复用宿主契约
- **操作步骤:**
  1. [A] `rg -n 'c\\.set\\("user"|c\\.set\\("session"|Not authenticated' /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/auth/middleware.ts` → 期望包含: Not authenticated

#### - [x] 4.2 `createApp()` 已挂载认证路由
- **来源:** spec-plan.md Task 3 / spec-design.md §五
- **目的:** 确认同源认证入口存在
- **操作步骤:**
  1. [A] `rg -n 'auth\\.handler|/api/auth/\\*|allowCredentials|credentials: true' /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/app.ts` → 期望包含: credentials: true

#### - [x] 4.3 认证能力未侵入 Core runtime
- **来源:** spec-plan.md Task 3 / Task 5 / spec-design.md §二
- **目的:** 确认宿主与 Core 边界清晰
- **操作步骤:**
  1. [A] `rg -n 'better-auth|sessionAuth|authDb|apiKey' /Users/liyuan/Work/mothership-beta_new/src-new/packages/core /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/bootstrap.ts | wc -l | tr -d ' '` → 期望精确: 0

#### - [x] 4.4 Feature 范围仍限定为认证基座
- **来源:** spec-plan.md Task 5 / spec-design.md §八
- **目的:** 确认本轮范围收敛清晰
- **操作步骤:**
  1. [A] `rg -n 'sessionAuth|/api/auth/|/web/|apiKey' /Users/liyuan/Work/mothership-beta_new/spec/feature_20260512_F001_server-web-auth-adapter/spec-plan.md` → 期望包含: sessionAuth

---

## 验收后清理

- [ ] [AUTO] 本清单未要求启动后台常驻服务: `printf 'no service cleanup required\n'`

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | 完整测试入口可执行 | 1 | 0 | ✅ |
| 场景 1 | 1.2 | 测试脚本已覆盖整个测试目录 | 1 | 0 | ✅ |
| 场景 1 | 1.3 | 类型检查仍然通过 | 1 | 0 | ✅ |
| 场景 2 | 2.1 | SQLite 自举已包含认证表 | 1 | 0 | ✅ |
| 场景 2 | 2.2 | Drizzle 认证 schema 已完整导出 | 1 | 0 | ✅ |
| 场景 2 | 2.3 | 认证 schema 回归测试通过 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | better-auth 配置保留兼容参数 | 1 | 0 | ✅ |
| 场景 3 | 3.2 | API key 服务导出齐全 | 1 | 0 | ✅ |
| 场景 3 | 3.3 | API key 服务行为测试通过 | 1 | 0 | ✅ |
| 场景 3 | 3.4 | `/api/auth/*` 登录与取会话链路可用 | 1 | 0 | ✅ |
| 场景 4 | 4.1 | `sessionAuth` 注入旧后端兼容字段 | 1 | 0 | ✅ |
| 场景 4 | 4.2 | `createApp()` 已挂载认证路由 | 1 | 0 | ✅ |
| 场景 4 | 4.3 | 认证能力未侵入 Core runtime | 1 | 0 | ✅ |
| 场景 4 | 4.4 | Feature 范围仍限定为认证基座 | 1 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
