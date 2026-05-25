# skill-launch-download 执行计划

**目标:** 将全局 Skill 存储迁移到可配置服务端目录，生成可下载 zip，并在 AgentLaunchSpec 中注入启用 Skill 的下载 URL。

**技术栈:** Bun + Elysia + PostgreSQL/Drizzle + TypeScript + Node fs/crypto/zlib

**设计文档:** spec/feature_20260520_F001_skill-launch-download/spec-design.md

## 改动总览

本次改动集中在后端 Skill 文件系统、Skill 服务编排、下载路由、launch spec 构建与环境配置，不修改前端页面交互。
Task 1 先建立 `SKILL_DIR` 配置和停止旧目录迁移，Task 2 提供安全路径与 zip artifact 能力，Task 3 将 artifact 生命周期接入创建、导入、启用、删除，Task 4 暴露带签名 token 且校验启用状态的 zip 下载路由，Task 5 将启用 Skill 写入 `AgentLaunchSpec.skills`。
经代码分析确认 `packages/plugin-sdk/src/agent-launch-spec.ts` 已有 `{ name, url }` 的 `SkillConfig`，`packages/plugin-opencode/src/runtime/skill-installer.ts` 已按 URL 下载并解压，因此不扩展 SDK 与插件行为。
仓库当前没有直接 zip 依赖，且设计要求避免依赖系统 `zip` 命令；本计划在 `src/services/skill-fs.ts` 中实现最小 ZIP Store writer，避免新增依赖和部署机器命令差异。

---

### Task 0: 环境准备

**背景:**
确保 Bun、TypeScript 与后端测试工具链可用，避免后续 Task 因本地环境或依赖安装问题阻塞。当前仓库根目录包含统一 `package.json`，后端与前端测试均从项目根目录执行。

**涉及文件:**
- 无代码文件改动。

**执行步骤:**
- [x] 验证 Bun 运行时可用
  - 位置: 项目根目录 `/Users/liyuan/Work/mothership-beta`
  - 执行 `bun --version`，确认命令可用并记录版本号。
  - 原因: 后续所有测试和类型检查都依赖 Bun。
- [x] 验证 TypeScript 类型检查入口可用
  - 位置: 项目根目录 `/Users/liyuan/Work/mothership-beta`
  - 执行 `bun run typecheck`，记录当前基线结果。
  - 原因: 本 feature 会修改跨模块类型，需先确认类型检查命令可运行。
- [x] 运行基线单元测试
  - 测试文件: `src/__tests__/env-validation.test.ts`
  - 测试场景:
    - 测试入口: Bun test 加载现有 `env validation` 测试文件 → 测试进程退出码为 0
  - 运行命令: `bun test src/__tests__/env-validation.test.ts`
  - 预期: `env validation` 测试通过。

**检查步骤:**
- [x] 检查 Bun 版本输出
  - `bun --version`
  - 预期: 输出 Bun 版本号，命令退出码为 0。
- [x] 检查类型检查命令可运行
  - `bun run typecheck`
  - 预期: TypeScript 完成检查，无新增错误。
- [x] 检查后端测试命令可运行
  - `bun test src/__tests__/env-validation.test.ts`
  - 预期: `env validation` 测试通过。

---

### Task 1: Skill 存储目录配置化

**背景:**
全局 Skill 当前固定使用 `~/.agents/skills`，不利于服务端部署、容器挂载和备份。本 Task 将存储根目录改为 `SKILL_DIR`，并停止启动时执行旧 `migrateSkillsDir()` 历史迁移，为后续 zip artifact 的统一路径打底。

**涉及文件:**
- 修改: `src/env.ts`
- 修改: `src/config.ts`
- 修改: `src/services/skill.ts`
- 修改: `src/index.ts`
- 修改: `src/__tests__/env-validation.test.ts`
- 新建: `src/__tests__/skill-dir-config.test.ts`

**执行步骤:**
- [x] 在 `src/env.ts` 声明 `SKILL_DIR`
  - 位置: `envSchema` 的服务器可选变量区，`RCS_VERSION` 之后（约 L13）。
  - 新增字段: `SKILL_DIR: z.string().default("./data/skills")`。
  - 原因: 让运行环境可以覆盖全局 Skill 数据根目录，同时默认落到项目数据目录。
- [x] 在 `src/config.ts` 暴露规范化后的 `config.skillDir`
  - 位置: `buildConfig(env)` 返回对象中，`baseUrl` 之后（约 L8）。
  - 导入 `resolve` from `node:path`，新增 `skillDir: resolve(env.SKILL_DIR)`。
  - 保持 `setConfig()` 当前浅合并方式，`skillDir` 作为顶层字段随 overrides 合并。
  - 原因: 相对路径统一按服务进程 CWD 解析，避免各模块自行拼接出不同绝对路径。
- [x] 在 `src/services/skill.ts` 替换全局目录常量
  - 位置: 删除 `homedir` import、`OLD_SKILLS_DIR` 与固定 `SKILLS_DIR` 常量（约 L8、L98-L99）。
  - 新增导入 `config` from `../config`，新增导出函数 `export function getGlobalSkillsDir(): string { return config.skillDir; }`。
  - 将 `skillContentPath()`、`setSkill()`、`deleteSkill()`、`importSkillDirectories()`、`listSkillSources()` 中的 `SKILLS_DIR` 全部替换为 `getGlobalSkillsDir()`。
  - 原因: 让测试和运行时通过 `setConfig({ skillDir })` 可控地切换目录。
- [x] 从 `src/services/skill.ts` 移除旧 `migrateSkillsDir()` 实现
  - 位置: 删除约 L114-L144 的 `migrateSkillsDir()` 函数及其旧目录迁移逻辑。
  - 保留 workspace skill 的 `.agents/skills` 扫描逻辑 `getWorkspaceSkillDir()` 不变。
  - 原因: 设计明确不执行旧 `~/.agents/skills` 或 `~/.config/opencode/skills` 的历史迁移。
- [x] 在 `src/index.ts` 停止调用旧迁移
  - 位置: 删除 `import { migrateSkillsDir } from "./services/skill";`（约 L46）和 `await migrateSkillsDir();`（约 L59）。
  - 保持 `await startScheduler();` 仍在 core runtime 初始化之后执行。
  - 原因: 启动时不再触碰用户 home 目录和历史 skill 目录。
- [x] 为环境配置和目录解析编写单元测试
  - 测试文件: `src/__tests__/env-validation.test.ts` 与 `src/__tests__/skill-dir-config.test.ts`
  - 测试场景:
    - 默认环境: 未设置 `SKILL_DIR` → `validateEnv().SKILL_DIR` 为 `./data/skills`
    - 覆盖环境: 设置 `SKILL_DIR=/tmp/rcs-skills` → `applyEnv(env)` 后 `config.skillDir` 为 `/tmp/rcs-skills`
    - 相对路径: 设置 `SKILL_DIR=./tmp-skills` → `config.skillDir` 等于 `resolve("./tmp-skills")`
  - 运行命令: `bun test src/__tests__/env-validation.test.ts src/__tests__/skill-dir-config.test.ts`
  - 预期: 所有测试通过。

**检查步骤:**
- [x] 验证旧迁移调用已移除
  - `rg "migrateSkillsDir|OLD_SKILLS_DIR|homedir\\(\\).*skills" src/index.ts src/services/skill.ts`
  - 预期: 无输出。
- [x] 验证 Skill 目录由配置派生
  - `rg "getGlobalSkillsDir|skillDir" src/services/skill.ts src/config.ts src/env.ts`
  - 预期: 输出包含 `getGlobalSkillsDir`、`config.skillDir`、`SKILL_DIR`。
- [x] 验证目录配置测试
  - `bun test src/__tests__/env-validation.test.ts src/__tests__/skill-dir-config.test.ts`
  - 预期: 所有测试通过。

---

### Task 2: Skill 文件系统 zip artifact 能力

**背景:**
RCS 当前只写入 Skill 源目录和 `SKILL.md`，没有供 opencode runtime 下载的 zip。本 Task 在纯文件系统层增加名称校验、安全路径、archive 路径、zip 生成与删除能力，供服务层复用。

**涉及文件:**
- 修改: `src/services/skill-fs.ts`
- 新建: `src/__tests__/skill-fs-archive.test.ts`

**执行步骤:**
- [x] 在 `src/services/skill-fs.ts` 增加 Skill 名称校验函数
  - 位置: `createSkillValidationError()` 之后（约 L63-L68）。
  - 新增 `export function assertValidSkillName(name: string): string`，逻辑为 trim 后拒绝空字符串、`.`、`..`、包含 `/`、包含 `\` 的名称，合法时返回 trim 后名称。
  - 将 `groupUploadFiles()` 中约 L120-L126 的名称校验替换为 `const skillName = assertValidSkillName(file.skillName)`。
  - 原因: set/import/download 共用同一名称边界，避免路径穿越。
- [x] 在 `src/services/skill-fs.ts` 增加源目录与 archive 路径工具
  - 位置: `assertValidSkillName()` 之后。
  - 新增 `export function getSkillSourceDir(skillRoot: string, name: string): string { return join(skillRoot, assertValidSkillName(name)); }`。
  - 新增 `export function getSkillArchivePath(skillRoot: string, name: string): string { return join(skillRoot, `${assertValidSkillName(name)}.zip`); }`。
  - 原因: 所有模块统一从 root/name 和 root/name.zip 计算路径。
- [x] 在 `src/services/skill-fs.ts` 实现 zip writer
  - 位置: 导入区增加 `stat` from `node:fs/promises`、`relative` from `node:path`、`crc32` 自实现辅助函数；在备份函数前新增 `export async function buildSkillArchive(sourceDir: string, archivePath: string): Promise<void>`。
  - 关键逻辑:
    ```ts
    const rootInfo = await stat(sourceDir);
    if (!rootInfo.isDirectory()) throw createSkillValidationError("Skill 源目录不存在");
    const files = await collectFiles(sourceDir); // readdir recursive, 仅 entry.isFile()
    for each file:
      const entryName = normalizeUploadPath(relative(sourceDir, filePath));
      write ZIP local header with method 0, crc32, sizes, entryName
      append file bytes
    write central directory and end record
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, Buffer.concat(parts));
    ```
  - ZIP 条目不包含 sourceDir 自身目录名，解压到 `.opencode/skills/<name>` 后直接得到 `SKILL.md`、`references/`、`scripts/`。
  - 原因: opencode 当前把 zip 解压到目标 skill 目录，archive 内部必须是目录内容而非再套一层 skillName。
- [x] 在 `src/services/skill-fs.ts` 增加 archive 删除能力
  - 位置: `deleteSkillDir()` 之后（约 L187-L192）。
  - 新增 `export async function deleteSkillArchive(skillRoot: string, name: string): Promise<void>`，调用 `rm(getSkillArchivePath(skillRoot, name), { force: true })`。
  - 原因: delete/rollback 可以清理 artifact。
- [x] 为 zip artifact 编写单元测试
  - 测试文件: `src/__tests__/skill-fs-archive.test.ts`
  - 测试场景:
    - 路径工具: `getSkillSourceDir(root, "demo")` → `${root}/demo`，`getSkillArchivePath(root, "demo")` → `${root}/demo.zip`
    - 名称校验: `""`、`.`、`..`、`a/b`、`a\\b` → 抛出 `VALIDATION_ERROR`
    - archive 生成: 源目录含 `SKILL.md` 与 `references/ref.md` → 生成 zip；测试代码用 Node 读取 ZIP 中央目录，验证包含两个条目
    - archive 删除: `deleteSkillArchive(root, "demo")` → `${root}/demo.zip` 不存在
  - 运行命令: `bun test src/__tests__/skill-fs-archive.test.ts`
  - 预期: 所有测试通过。

**检查步骤:**
- [x] 验证新增 API 已导出
  - `rg "assertValidSkillName|getSkillSourceDir|getSkillArchivePath|buildSkillArchive|deleteSkillArchive" src/services/skill-fs.ts`
  - 预期: 每个函数均有导出定义。
- [x] 验证未新增外部 zip 依赖
  - `rg '"(archiver|jszip|yazl|fflate)"' package.json`
  - 预期: 无输出。
- [x] 验证文件系统 artifact 测试
  - `bun test src/__tests__/skill-fs-archive.test.ts`
  - 预期: 所有测试通过。

---

### Task 3: Skill 服务层接入 archive 生命周期

**背景:**
zip 生成必须跟随全局 Skill 的创建、编辑、上传导入、覆盖导入、启用和删除生命周期，避免 PG 中存在 Skill 但下载返回 404。本 Task 将 Task 2 的文件系统能力接入 `src/services/skill.ts`，并保持 workspace skill 不生成全局 archive。

**涉及文件:**
- 修改: `src/services/skill.ts`
- 修改: `src/__tests__/skill-import-shared-validation.test.ts`
- 修改: `src/__tests__/skill-import-parallel-deletes.test.ts`
- 新建: `src/__tests__/skill-archive-lifecycle.test.ts`

**执行步骤:**
- [x] 扩展 `src/services/skill.ts` 的 `_deps.skillFs`
  - 位置: `_deps.skillFs` 初始化与 `_resetDeps()` 中（约 L27-L55、L60-L87）。
  - 新增 `assertValidSkillName`、`getSkillSourceDir`、`getSkillArchivePath`、`buildSkillArchive`、`deleteSkillArchive` 四个依赖引用。
  - 原因: 现有测试通过 `_deps` 注入 mock，新增文件系统行为也需可替换。
- [x] 在 `src/services/skill.ts` 使用安全名称和配置目录
  - 位置: `skillContentPath(name)`（约 L150-L152）、`setSkill()`（约 L186-L208）、`deleteSkill()`（约 L211-L218）、`importSkillDirectories()`（约 L304-L361）。
  - 在入口处使用 `const safeName = _deps.skillFs.assertValidSkillName(name)`，并将 `safeName` 传入路径和 PG 操作。
  - 将 `join(root, safeName)` 替换为 `_deps.skillFs.getSkillSourceDir(getGlobalSkillsDir(), safeName)`。
  - 原因: 所有全局 Skill 操作先经过同一名称边界。
- [x] 在 `setSkill()` 中生成 archive 并补齐失败回滚
  - 位置: 写入 `contentPath` 后、`upsertSkill()` 前（约 L191-L195）。
  - 写入前用现有 `_deps.skillFs.createBackupDir()` 与 `_deps.skillFs.backupSkillDirs()` 备份 `[safeName]`，写入后新增 `await _deps.skillFs.buildSkillArchive(skillDir, _deps.skillFs.getSkillArchivePath(getGlobalSkillsDir(), safeName))`。
  - `catch` 中先调用 `cleanupWrittenSkills(root, [safeName])`，再调用 `restoreFromBackup(snapshots, root)`；根据 `snapshots.get(safeName)` 分支处理 archive：值为备份路径时重新 `buildSkillArchive(skillDir, archivePath)`，值为 `null` 时调用 `deleteSkillArchive(root, safeName)`。
  - `finally` 中调用 `cleanupBackupDir(backupRoot)`。
  - 原因: PG 写入成功前 archive 已可用，PG 失败时新建 skill 不留下孤儿文件，编辑已有 skill 不丢失旧版本。
- [x] 在 `deleteSkill()` 中同步删除 archive
  - 位置: `deleteSkillDir(skillDir)` 后（约 L214-L217）。
  - 新增 `await _deps.skillFs.deleteSkillArchive(getGlobalSkillsDir(), safeName).catch(...)`。
  - 原因: 删除全局 Skill 后 source 与 archive 一并清理。
- [x] 在 `enableSkill()` 中补生成缺失 archive
  - 位置: `enableSkill(ctx, name)`（约 L221-L223）。
  - 先读取 `meta = await _deps.configPg.getSkill(ctx, safeName)`，不存在返回 `false`；存在时计算 `sourceDir = getSkillSourceDir(root, safeName)`，调用 `buildSkillArchive(sourceDir, archivePath)`，再调用 `configPg.enableSkill(ctx, safeName)`。
  - 原因: 历史或测试数据缺少 zip 时，启用前可恢复 artifact；disable 不删除 archive。
- [x] 在全局导入成功路径生成 archive
  - 位置: `importSkillDirectories()` 调用 `executeImportCore()` 的 `onSkillWritten` 回调（约 L347-L353）。
  - 在 `upsertSkill()` 前新增 `buildSkillArchive(getSkillSourceDir(root, info.name), getSkillArchivePath(root, info.name))`。
  - 原因: 上传导入成功后 `${SKILL_DIR}/<name>.zip` 必然存在。
- [x] 在全局导入 overwrite 回滚路径恢复 archive
  - 位置: `executeImportCore()` 参数列表（约 L247-L255）增加 `onRestoreComplete?: (names: string[]) => Promise<void>`；catch 中 `restoreFromBackup(snapshots, targetDir)` 成功后调用它。
  - 全局 `importSkillDirectories()` 传入 `async (names) => Promise.all(names.map((name) => buildSkillArchive(getSkillSourceDir(root, name), getSkillArchivePath(root, name))))`，并在 `onRollbackCleanup` 中删除 attemptedNames 的 archive。
  - 原因: overwrite 失败后源目录恢复为旧版本，对应 zip 也恢复为旧版本；新写入失败不残留错误 zip。
- [x] 更新已有 mock 测试的 `_deps.skillFs`
  - 位置: `src/__tests__/skill-import-shared-validation.test.ts` 与 `src/__tests__/skill-import-parallel-deletes.test.ts` 的 `beforeEach()`。
  - 给 mock 补充 `assertValidSkillName`、`getSkillSourceDir`、`getSkillArchivePath`、`buildSkillArchive`、`deleteSkillArchive`，其中 `assertValidSkillName` 返回 trim 后名称，其余函数返回可预测路径或空 async。
  - 原因: 保持既有导入验证和并行删除测试不因新增依赖失败。
- [x] 为服务层 archive 生命周期编写单元测试
  - 测试文件: `src/__tests__/skill-archive-lifecycle.test.ts`
  - 测试场景:
    - `setSkill()` 写入 `SKILL.md` 后调用 `buildSkillArchive(sourceDir, archivePath)`，并将 `contentPath` 写入 PG
    - `setSkill()` 新建 skill 时 PG upsert 失败 → 删除新 source 与 archive
    - `setSkill()` 编辑已有 skill 时 PG upsert 失败 → 恢复旧 source 并重新生成旧 archive
    - `deleteSkill()` PG 删除成功后调用 `deleteSkillDir` 与 `deleteSkillArchive`
    - `enableSkill()` 对存在的 meta 先调用 `buildSkillArchive`，再调用 `configPg.enableSkill`
    - `importSkillDirectories()` 成功导入后对每个 imported skill 生成 archive
    - `importSkillDirectories()` overwrite 回滚后重新生成旧 archive，并删除 attempted archive
  - 运行命令: `bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-import-shared-validation.test.ts src/__tests__/skill-import-parallel-deletes.test.ts`
  - 预期: 所有测试通过。

**检查步骤:**
- [x] 验证服务层引用 archive API
  - `rg "buildSkillArchive|deleteSkillArchive|getSkillArchivePath|getSkillSourceDir|assertValidSkillName" src/services/skill.ts`
  - 预期: 输出覆盖 `_deps`、`setSkill`、`deleteSkill`、`enableSkill`、`importSkillDirectories`。
- [x] 验证 workspace skill 未接入全局 archive
  - `rg "buildSkillArchive|deleteSkillArchive" -n src/services/skill.ts`
  - 预期: 输出仅位于全局 `setSkill`、`deleteSkill`、`enableSkill`、`importSkillDirectories` 相关代码块，不位于 `setWorkspaceSkill` 或 `importWorkspaceSkillDirectories`。
- [x] 验证服务层生命周期测试
  - `bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-import-shared-validation.test.ts src/__tests__/skill-import-parallel-deletes.test.ts`
  - 预期: 所有测试通过。

---

### Task 4: Skill zip 下载 token 与路由

**背景:**
opencode runtime 的 `fetch(skill.url)` 不携带浏览器 cookie，因此 Skill zip 下载不能依赖 `sessionAuth`。本 Task 增加基于 `RCS_API_KEYS` 的短期签名 token，并提供 `GET /web/skills/:name/download` 返回 zip 文件。

**涉及文件:**
- 新建: `src/services/skill-download-token.ts`
- 新建: `src/routes/web/skills.ts`
- 修改: `src/index.ts`
- 新建: `src/__tests__/skill-download-token.test.ts`
- 新建: `src/__tests__/skill-download-route.test.ts`

**执行步骤:**
- [x] 新建 `src/services/skill-download-token.ts`
  - 位置: 新文件。
  - 实现 `generateSkillDownloadToken(skill: { id: string; teamId: string; name: string }, options?: { expiresInSeconds?: number }): string` 与 `verifySkillDownloadToken(token: string): { skillId: string; teamId: string; skillName: string; exp: number } | null`。
  - 关键逻辑: 复用 `node:crypto` 的 HMAC-SHA256；新增内部 `getSigningKey()` 返回 `process.env.RCS_API_KEYS?.split(",").filter(Boolean)[0]`，缺少签名 key 时 `generateSkillDownloadToken()` 抛出 `RCS_API_KEYS is required for skill download token`，`verifySkillDownloadToken()` 返回 null；payload 包含 `type: "skill-download"`、`skillId`、`teamId`、`skillName`、`iat`、`exp`；verify 校验签名、类型、`skillId`、`teamId`、`skillName` 与过期时间。
  - 额外导出 `buildSkillDownloadUrl(skill: { id: string; teamId: string; name: string }, options?: { expiresInSeconds?: number }): string`，返回 `${getBaseUrl()}/web/skills/${encodeURIComponent(skill.name)}/download?token=${token}`。
  - 原因: launch spec 构建与下载路由共享同一 token 语义。
- [x] 新建 `src/routes/web/skills.ts`
  - 位置: 新文件，Elysia prefix 使用 `/web/skills`，不 `.use(authGuardPlugin)`，不设置 `sessionAuth`。
  - 导入 `stat` from `node:fs/promises`、`createReadStream` from `node:fs`、`and`/`eq`/`isNull` from `drizzle-orm`、`db` from `../../db`、`skill` from `../../db/schema`、`assertValidSkillName`/`getSkillArchivePath` from `../../services/skill-fs`、`getGlobalSkillsDir` from `../../services/skill`、`verifySkillDownloadToken` from `../../services/skill-download-token`。
  - 新增 `app.get("/:name/download", async ({ params, query, error, set }) => { ... })`。
  - 关键逻辑:
    ```ts
    let name: string;
    try {
      name = assertValidSkillName(params.name);
    } catch {
      return error(400, { error: { type: "validation_error", message: "Invalid skill name" } });
    }
    const token = typeof query.token === "string" ? query.token : "";
    const payload = verifySkillDownloadToken(token);
    if (!payload || payload.skillName !== name) return error(403, { error: { type: "forbidden", message: "Invalid skill download token" } });
    const rows = await db.select({ id: skill.id }).from(skill).where(and(
      eq(skill.id, payload.skillId),
      eq(skill.teamId, payload.teamId),
      eq(skill.name, name),
      eq(skill.enabled, true),
      isNull(skill.environmentId),
    )).limit(1);
    if (rows.length === 0) return error(404, { error: { type: "not_found", message: "Skill not found" } });
    const archivePath = getSkillArchivePath(getGlobalSkillsDir(), name);
    const info = await stat(archivePath).catch(() => null);
    if (!info?.isFile()) return error(404, { error: { type: "not_found", message: "Skill archive not found" } });
    set.headers["Content-Type"] = "application/zip";
    set.headers["Content-Disposition"] = `attachment; filename="${name}.zip"`;
    return new Response(createReadStream(archivePath) as unknown as ReadableStream);
    ```
  - 原因: 下载路由只信任签名 token，不直接按未校验 path 读文件。
- [x] 在 `src/index.ts` 挂载下载路由
  - 位置: web routes import 区新增 `import webSkills from "./routes/web/skills";`，`.use(webConfig)` 后追加 `.use(webSkills)`。
  - 原因: `/web/skills/:name/download` 与 `/web/config/skills` 同属 web API，但下载路由不走 config body。
- [x] 为 token 工具编写单元测试
  - 测试文件: `src/__tests__/skill-download-token.test.ts`
  - 测试场景:
    - 生成并验证 token: `generateSkillDownloadToken({ id: "skill-1", teamId: "team-1", name: "demo" }, { expiresInSeconds: 60 })` → verify 返回 `skillId: "skill-1"`、`teamId: "team-1"`、`skillName: "demo"`
    - 篡改 token: 修改最后一个字符 → verify 返回 null
    - 过期 token: 使用 `expiresInSeconds: -1` → verify 返回 null
    - 缺少签名 key: 清空 `RCS_API_KEYS` 后调用 `generateSkillDownloadToken()` → 抛出 `RCS_API_KEYS is required for skill download token`
    - URL 生成: 设置 `setConfig({ baseUrl: "http://rcs.test" })` → URL 为 `http://rcs.test/web/skills/demo/download?token=...`
  - 运行命令: `bun test src/__tests__/skill-download-token.test.ts`
  - 预期: 所有测试通过。
- [x] 为下载路由编写单元测试
  - 测试文件: `src/__tests__/skill-download-route.test.ts`
  - 测试场景:
    - token 正确且 archive 存在 → HTTP 200，`Content-Type` 为 `application/zip`，body 等于 zip 文件内容
    - 缺少 token → HTTP 403
    - token 中 skillName 与路径参数不匹配 → HTTP 403
    - token 正确但 DB 中 skill 为 disabled → HTTP 404
    - 过期 token → HTTP 403
    - token 正确但 archive 不存在 → HTTP 404
    - 非法 name `../x` → HTTP 400
  - 运行命令: `bun test src/__tests__/skill-download-route.test.ts`
  - 预期: 所有测试通过。

**检查步骤:**
- [x] 验证下载路由未使用 sessionAuth
  - `rg "sessionAuth|authGuardPlugin" src/routes/web/skills.ts`
  - 预期: 无输出。
- [x] 验证路由已挂载
  - `rg "webSkills|routes/web/skills" src/index.ts`
  - 预期: 输出 import 与 `.use(webSkills)`。
- [x] 验证 token 与路由测试
  - `bun test src/__tests__/skill-download-token.test.ts src/__tests__/skill-download-route.test.ts`
  - 预期: 所有测试通过。

---

### Task 5: AgentLaunchSpec 注入启用 Skill URL

**背景:**
`buildLaunchSpec()` 当前固定返回 `skills: []`，导致 PG 中已启用的全局 Skill 和 agent 专属 Skill 无法进入 core/opencode runtime。本 Task 将 `fullConfig.skills` 映射为 SDK `SkillConfig[]`，并对缺失 archive 的启用 Skill 明确报错。

**涉及文件:**
- 修改: `src/services/launch-spec-builder.ts`
- 新建: `src/__tests__/launch-spec-skills.test.ts`

**执行步骤:**
- [x] 在 `src/services/launch-spec-builder.ts` 引入 Skill URL 和 archive 校验依赖
  - 位置: import 区（约 L1-L5）。
  - 新增导入 `existsSync` from `node:fs`、`buildSkillDownloadUrl` from `./skill-download-token`、`getGlobalSkillsDir` from `./skill`、`getSkillArchivePath` from `./skill-fs`。
  - 原因: launch spec 构建时生成短期 URL，并阻止缺失 artifact 的 enabled skill 静默丢失。
- [x] 在 `buildLaunchSpec()` 中构建 `skills`
  - 位置: MCP server 循环结束后、knowledge binding 查询前（约 L138-L139）。
  - 新增:
    ```ts
    const skills = fullConfig.skills
      .filter((skill) => skill.enabled)
      .map((skill) => {
        const archivePath = getSkillArchivePath(getGlobalSkillsDir(), skill.name);
        if (!existsSync(archivePath)) {
          throw new Error(`Skill archive missing: ${skill.name}`);
        }
        return { name: skill.name, url: buildSkillDownloadUrl(skill, { expiresInSeconds: 3600 }) };
      });
    ```
  - 将返回对象中的 `skills: []`（约 L154）替换为 `skills`。
  - 原因: 启用 Skill 进入 runtime，禁用 Skill 不进入；缺失 archive 以错误暴露数据不一致。
- [x] 保持知识库 MCP 注入逻辑不变
  - 位置: `knowledgeBindings` 相关代码（约 L139-L148）只读取 `agentConfigId`，继续向 `mcpServers` 追加 `kb`。
  - 原因: Skill URL 注入与 knowledge MCP 是并列资源准备，不能改变现有 knowledge 行为。
- [x] 为 launch spec skill 映射编写单元测试
  - 测试文件: `src/__tests__/launch-spec-skills.test.ts`
  - 测试场景:
    - enabled global skill + agent-scoped skill 且 archive 存在 → `spec.skills` 包含两个 `{ name, url }`
    - disabled skill 且 archive 存在 → 不进入 `spec.skills`
    - enabled skill 缺少 `${SKILL_DIR}/<name>.zip` → `buildLaunchSpec()` 抛出 `Skill archive missing: <name>`
    - URL 包含 `/web/skills/<encoded-name>/download?token=`，且 token 可通过 `verifySkillDownloadToken()` 验证出当前 skill 的 `id`、`teamId`、`name`
  - 运行命令: `bun test src/__tests__/launch-spec-skills.test.ts`
  - 预期: 所有测试通过。

**检查步骤:**
- [x] 验证 launch spec 不再硬编码空 skills
  - `rg "skills: \\[\\]" src/services/launch-spec-builder.ts`
  - 预期: 无输出。
- [x] 验证 Skill URL 构建逻辑存在
  - `rg "buildSkillDownloadUrl|getSkillArchivePath|Skill archive missing" src/services/launch-spec-builder.ts`
  - 预期: 输出三处关键引用。
- [x] 验证 launch spec skill 测试
  - `bun test src/__tests__/launch-spec-skills.test.ts`
  - 预期: 所有测试通过。

---

### Task 6: skill-launch-download 验收

**前置条件:**
- 在项目根目录 `/Users/liyuan/Work/mothership-beta` 执行。
- 测试环境变量包含 `DATABASE_URL=postgres://u:p@h:5432/db` 与 `RCS_API_KEYS=test-key`。
- 本 feature 不修改前端代码，验收不要求执行 `bun run build:web`。

**端到端验证:**

1. [x] 运行完整后端测试套件确保无回归
   - `bun test src/__tests__/`
   - 预期: 后端测试全部通过。
   - 失败排查: 检查 Task 1 到 Task 5 中对应模块的专项测试。

2. [x] 运行 TypeScript 类型检查
   - `bun run typecheck`
   - 预期: 无 TypeScript 错误。
   - 失败排查: 检查 Task 1 的 `config.skillDir` 类型、Task 3 的 `_deps.skillFs` 类型、Task 5 的 `AgentLaunchSpec.skills` 类型。

3. [x] 验证新建 Skill 会写入配置目录并生成 archive
   - `bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-fs-archive.test.ts`
   - 预期: `setSkill()`、导入、删除、启用补 archive 的测试全部通过。
   - 失败排查: 检查 Task 2 `buildSkillArchive()` 与 Task 3 服务层回滚逻辑。

4. [x] 验证下载路由 token 安全边界
   - `bun test src/__tests__/skill-download-token.test.ts src/__tests__/skill-download-route.test.ts`
   - 预期: 正确 token 返回 zip，缺失、篡改、过期、不匹配 token 返回 403，disabled skill 与缺失 archive 返回 404。
   - 失败排查: 检查 Task 4 `skill-download-token.ts` 与 `routes/web/skills.ts`。

5. [x] 验证 launch spec 注入启用 Skill 下载 URL
   - `bun test src/__tests__/launch-spec-skills.test.ts`
   - 预期: enabled global skill 和 agent-scoped skill 进入 `AgentLaunchSpec.skills`，disabled skill 被过滤，缺失 archive 抛错。
   - 失败排查: 检查 Task 5 `buildLaunchSpec()` 的 skills 映射。

6. [x] 验证旧历史迁移已停止
   - `rg "migrateSkillsDir|OLD_SKILLS_DIR|\\.config/opencode/skills" src/index.ts src/services/skill.ts`
   - 预期: 无输出；旧迁移函数、旧 opencode 目录和启动调用均已移除。
   - 失败排查: 检查 Task 1 是否完全移除启动迁移和旧全局目录常量。

7. [x] 验证 workspace skill 目录逻辑仍保留在 workspace 范围
   - `rg "\\.agents\", \"skills" src/services/skill.ts`
   - 预期: 仅输出 `getWorkspaceSkillDir()` 中的 workspace skill 路径拼接。
   - 失败排查: 检查 Task 1 是否误删 workspace skill 扫描能力。
