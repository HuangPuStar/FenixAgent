# skill-launch-download 人工验收清单

**生成时间:** 2026-05-20 14:27
**关联计划:** spec/feature_20260520_F001_skill-launch-download/spec-plan.md
**关联设计:** spec/feature_20260520_F001_skill-launch-download/spec-design.md

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 运行时: `bun --version`
- [ ] [AUTO] 确认测试签名环境: `RCS_API_KEYS=test-key DATABASE_URL=postgres://u:p@h:5432/db bun --version`

### 测试数据准备
- [ ] [AUTO] 本清单主要依赖单元测试自建临时目录、mock DB 与测试 token，无需人工准备测试数据: `pwd`

---

## 验收项目

### 场景 1：环境配置与存储目录

#### - [x] 1.1 SKILL_DIR 默认值与覆盖生效
- **来源:** spec-plan.md Task 1 / spec-design.md §存储目录设计
- **目的:** 确认目录配置生效
- **操作步骤:**
  1. [A] `bun test src/__tests__/env-validation.test.ts src/__tests__/skill-dir-config.test.ts` → 期望包含: `pass`

#### - [x] 1.2 旧历史迁移逻辑已停止
- **来源:** spec-plan.md Task 1、Task 6 / spec-design.md §历史数据与迁移
- **目的:** 确认不触碰旧目录
- **操作步骤:**
  1. [A] `rg "migrateSkillsDir|OLD_SKILLS_DIR|\\.config/opencode/skills" src/index.ts src/services/skill.ts` → 期望精确: ``

#### - [x] 1.3 workspace skill 扫描仍保留
- **来源:** spec-plan.md Task 6 / spec-design.md §buildLaunchSpec 接入
- **目的:** 确认工作区能力保留
- **操作步骤:**
  1. [A] `rg "\\.agents\", \"skills" src/services/skill.ts` → 期望包含: `getWorkspaceSkillDir`

---

### 场景 2：Skill 文件系统与 zip artifact

#### - [x] 2.1 名称校验和 archive 路径工具可用
- **来源:** spec-plan.md Task 2 / spec-design.md §zip 生成策略
- **目的:** 确认路径边界安全
- **操作步骤:**
  1. [A] `rg "assertValidSkillName|getSkillSourceDir|getSkillArchivePath|buildSkillArchive|deleteSkillArchive" src/services/skill-fs.ts` → 期望包含: `export`
  2. [A] `bun test src/__tests__/skill-fs-archive.test.ts` → 期望包含: `pass`

#### - [x] 2.2 未新增外部 zip 依赖
- **来源:** spec-plan.md Task 2 / spec-design.md §zip 生成策略
- **目的:** 确认部署依赖稳定
- **操作步骤:**
  1. [A] `rg '"(archiver|jszip|yazl|fflate)"' package.json` → 期望精确: ``

---

### 场景 3：Skill 服务生命周期

#### - [x] 3.1 创建编辑导入启用会生成 archive
- **来源:** spec-plan.md Task 3 / spec-design.md §zip 生成策略
- **目的:** 确认产物生命周期完整
- **操作步骤:**
  1. [A] `bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-import-shared-validation.test.ts src/__tests__/skill-import-parallel-deletes.test.ts` → 期望包含: `pass`

#### - [x] 3.2 服务层引用 archive API
- **来源:** spec-plan.md Task 3 / spec-design.md §实现要点
- **目的:** 确认编排接入完整
- **操作步骤:**
  1. [A] `rg "buildSkillArchive|deleteSkillArchive|getSkillArchivePath|getSkillSourceDir|assertValidSkillName" src/services/skill.ts` → 期望包含: `buildSkillArchive`

#### - [x] 3.3 workspace skill 不生成全局 archive
- **来源:** spec-plan.md Task 3 / spec-design.md §buildLaunchSpec 接入
- **目的:** 确认来源边界清晰
- **操作步骤:**
  1. [A] `rg "buildSkillArchive|deleteSkillArchive" -n src/services/skill.ts` → 期望包含: `setSkill`

---

### 场景 4：下载 token 与 zip 路由

#### - [x] 4.1 token 生成校验与 URL 构建正确
- **来源:** spec-plan.md Task 4 / spec-design.md §下载 URL 与路由
- **目的:** 确认下载授权安全
- **操作步骤:**
  1. [A] `bun test src/__tests__/skill-download-token.test.ts` → 期望包含: `pass`

#### - [x] 4.2 下载路由安全边界正确
- **来源:** spec-plan.md Task 4、Task 6 / spec-design.md §下载 URL 与路由
- **目的:** 确认路由拒绝非法访问
- **操作步骤:**
  1. [A] `bun test src/__tests__/skill-download-route.test.ts` → 期望包含: `pass`

#### - [x] 4.3 下载路由不依赖 sessionAuth
- **来源:** spec-plan.md Task 4 / spec-design.md §下载 URL 与路由
- **目的:** 确认 runtime 可下载
- **操作步骤:**
  1. [A] `rg "sessionAuth|authGuardPlugin" src/routes/web/skills.ts` → 期望精确: ``

#### - [x] 4.4 下载路由已挂载到应用
- **来源:** spec-plan.md Task 4 / spec-design.md §实现要点
- **目的:** 确认接口可达
- **操作步骤:**
  1. [A] `rg "webSkills|routes/web/skills" src/index.ts` → 期望包含: `webSkills`

---

### 场景 5：AgentLaunchSpec 注入 Skill URL

#### - [x] 5.1 enabled skill 注入下载 URL
- **来源:** spec-plan.md Task 5、Task 6 / spec-design.md §buildLaunchSpec 接入
- **目的:** 确认运行时收到 skill
- **操作步骤:**
  1. [A] `bun test src/__tests__/launch-spec-skills.test.ts` → 期望包含: `pass`

#### - [x] 5.2 launch spec 不再硬编码空 skills
- **来源:** spec-plan.md Task 5 / spec-design.md §需求背景
- **目的:** 确认注入逻辑生效
- **操作步骤:**
  1. [A] `rg "skills: \\[\\]" src/services/launch-spec-builder.ts` → 期望精确: ``

#### - [x] 5.3 缺失 archive 会显式报错
- **来源:** spec-plan.md Task 5 / spec-design.md §buildLaunchSpec 接入
- **目的:** 确认数据不静默丢失
- **操作步骤:**
  1. [A] `rg "buildSkillDownloadUrl|getSkillArchivePath|Skill archive missing" src/services/launch-spec-builder.ts` → 期望包含: `Skill archive missing`

---

### 场景 6：整体回归

#### - [!] 6.1 后端完整测试通过
- **来源:** spec-plan.md Task 6 / spec-design.md §验收标准
- **目的:** 确认后端无回归
- **操作步骤:**
  1. [A] `bun test src/__tests__/` → 期望包含: `pass`

#### - [ ] 6.2 TypeScript 类型检查通过
- **来源:** spec-plan.md Task 6 / spec-design.md §验收标准
- **目的:** 确认类型契约正确
- **操作步骤:**
  1. [A] `bun run typecheck` → 期望包含: `tsc`

---

## 验收后清理

- [ ] [AUTO] 无后台服务需要终止: `true`

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | SKILL_DIR 默认值与覆盖生效 | 1 | 0 | ✅ |
| 场景 1 | 1.2 | 旧历史迁移逻辑已停止 | 1 | 0 | ✅ |
| 场景 1 | 1.3 | workspace skill 扫描仍保留 | 1 | 0 | ✅ |
| 场景 2 | 2.1 | 名称校验和 archive 路径工具可用 | 2 | 0 | ✅ |
| 场景 2 | 2.2 | 未新增外部 zip 依赖 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | 创建编辑导入启用会生成 archive | 1 | 0 | ✅ |
| 场景 3 | 3.2 | 服务层引用 archive API | 1 | 0 | ✅ |
| 场景 3 | 3.3 | workspace skill 不生成全局 archive | 1 | 0 | ✅ |
| 场景 4 | 4.1 | token 生成校验与 URL 构建正确 | 1 | 0 | ✅ |
| 场景 4 | 4.2 | 下载路由安全边界正确 | 1 | 0 | ✅ |
| 场景 4 | 4.3 | 下载路由不依赖 sessionAuth | 1 | 0 | ✅ |
| 场景 4 | 4.4 | 下载路由已挂载到应用 | 1 | 0 | ✅ |
| 场景 5 | 5.1 | enabled skill 注入下载 URL | 1 | 0 | ✅ |
| 场景 5 | 5.2 | launch spec 不再硬编码空 skills | 1 | 0 | ✅ |
| 场景 5 | 5.3 | 缺失 archive 会显式报错 | 1 | 0 | ✅ |
| 场景 6 | 6.1 | 后端完整测试通过 | 1 | 0 | ❌ |
| 场景 6 | 6.2 | TypeScript 类型检查通过 | 1 | 0 | ⬜ |

**验收结论:** ⬜ 全部通过 / ✅ 存在问题
