# Skill 存储按组织分层与启动数据迁移

**日期**: 2026-06-07
**状态**: Approved

## 背景

当前 skill 元数据已经按 `organizationId` 存在数据库中，但文件系统仍使用全局单层目录：

- 源目录：`data/skills/<skillName>/SKILL.md`
- 归档文件：`data/skills/<skillName>.zip`

这会导致不同组织的同名 skill 在文件系统中互相覆盖。与此同时，`skill.content_path` 将物理路径写死到数据库，也让后续目录结构调整变得脆弱。

## 目标

1. skill 文件存储改为按组织分层，彻底隔离不同组织的同名 skill
2. `skill` 表移除 `content_path` 字段，skill 物理路径统一通过规则推导
3. 启动时自动执行一次数据迁移，将旧目录搬迁到新结构
4. 引入通用 `data_migrate` 机制，后续启动数据修复可复用

## 不做的事

- 不处理“运行中新建组织自动同步内置 skill”的问题
- 不为旧路径保留长期兼容逻辑
- 不把 `data_migrate_record` 做成按组织维度

## 设计

### 1. 新的 skill 存储结构

文件系统统一改成：

```text
data/skills/
  <organizationId>/
    <skillName>/
      SKILL.md
      references/...
    <skillName>.zip
```

规则约束：

- `organizationId` 是一级隔离边界
- `skillName` 继续沿用现有合法名称校验
- `SKILL.md`、归档 zip 均不再落库
- 所有物理路径都由 `(skillRoot, organizationId, skillName)` 推导

### 2. 路径推导职责收口

在 `src/services/skill-fs.ts` 中新增并统一维护组织级路径函数，供所有调用方复用：

- `getSkillOrganizationDir(skillRoot, organizationId)`
- `getSkillSourceDir(skillRoot, organizationId, name)`
- `getSkillMdPath(skillRoot, organizationId, name)`
- `getSkillArchivePath(skillRoot, organizationId, name)`

`skill.ts`、`launch-spec-builder.ts`、`meta-agent.ts`、下载路由不再自己拼接 skill 路径。

### 3. 数据库变更

#### `skill` 表

- 删除 `content_path`
- 保留 `description` 作为快照字段
- 保留 `metadata`

删除后，skill 文件路径由 `organizationId + name` 推导；外部共享 skill 也根据“资源所属组织 + skill 名称”定位物理目录。

#### `data_migrate_record` 表

新增一张全局数据迁移记录表：

- `id`
- `name`
- `createdAt`

约束：

- `name` 唯一
- 不带 `organizationId`

用途：

- 标记某个启动数据迁移是否已执行过
- 作为后续所有启动数据修复任务的统一执行记录

### 4. 启动数据迁移框架

新增 `src/services/data-migrate.ts` 作为通用 runner：

- 代码中维护一个按顺序排列的 migrate 列表
- 启动时先查询 `data_migrate_record`
- 按声明顺序依次执行尚未完成的 migrate
- 每个 migrate 成功后立刻写入一条 record

执行位置：

- `src/index.ts`
- `initDb()` 之后
- `syncBuiltinSkills()` 之前
- 其他依赖 skill 文件结构的启动逻辑之前

失败策略：

- 任意一个未完成 migrate 执行失败，直接中止启动
- 不允许系统在“部分迁移成功、部分仍按旧结构”的状态下继续运行

### 5. 本次 skill 存储迁移

新增独立 migrate 文件，例如：

- `src/services/data-migrates/migrate-skill-storage-by-organization.ts`

迁移逻辑按 `skill` 表逐条处理：

1. 读取 `organizationId + name`
2. 计算旧目录 `data/skills/<skillName>/`
3. 计算新目录 `data/skills/<orgId>/<skillName>/`
4. 如果旧目录不存在，跳过
5. 如果旧目录存在且新目录不存在：
   - 复制旧目录到新目录
   - 基于新目录重建 `data/skills/<orgId>/<skillName>.zip`
   - 删除旧目录和旧 zip
6. 如果旧目录存在且新目录也存在：
   - 保守跳过
   - 记录 warning
   - 不删除任何旧内容
7. 如果新目录存在且旧目录不存在：
   - 视为已在新结构，跳过

归档策略：

- 不直接迁移旧 zip
- 一律基于新目录重建 zip
- 这样可以避免旧 zip 与目录内容不一致

### 6. 代码改动范围

#### `src/services/skill.ts`

- 所有读写、导入、删除逻辑改为按 `ctx.organizationId + skillName` 推导路径
- `listSkills()` / `getSkill()` / `setSkill()` / `deleteSkill()` / `importSkillDirectories()` 删除对 `contentPath` 的依赖
- 外部共享 skill 读取路径改为按“skill 记录所属组织”推导

#### `src/services/config/skill.ts`

- `upsertSkill()` 不再接收和写入 `contentPath`
- `SkillConfigRow` / `SkillUpsertData` / 相关类型同步收敛

#### `src/services/launch-spec-builder.ts`

- skill source/archive 路径改为根据 skill 行的 `organizationId + name` 推导
- 共享 skill 也从源组织目录读取

#### `src/services/meta-agent.ts`

- 内置 skill 同步目标改为 `data/skills/<orgId>/<skillName>/`
- 额外文件同步和 archive 重建同样走组织级路径函数

#### `src/routes/web/skills.ts`

- 下载 zip 路径改为按 skill 所属组织推导

#### `src/index.ts`

- 在启动阶段执行 `runDataMigrations()`

### 7. 测试

需要补齐或调整以下验证：

1. 组织级路径函数测试
2. 同名 skill 跨组织不会覆盖
3. `setSkill` / `importSkillDirectories` / `deleteSkill` 改用组织级路径后的行为测试
4. 共享 skill 在无 `content_path` 后仍能读取源组织目录
5. `launch-spec-builder` 对 skill source/archive 路径的解析测试
6. 启动数据迁移测试：
   - 旧目录迁移到新目录
   - 新目录已存在时保守跳过
   - migrate 成功后写入 `data_migrate_record`
   - 已执行过的 migrate 启动时不重复执行

## 验证标准

1. 不同组织可创建同名 skill，文件系统中互不覆盖
2. `skill` 表不再存储 `content_path`
3. 启动时旧 skill 目录可自动迁移到按组织分层的新结构
4. 迁移执行记录会写入 `data_migrate_record`
5. 已执行过的数据迁移不会在后续启动时重复执行
6. skill 下载、launch spec 构建、meta-agent 内置 skill 同步在新路径结构下正常工作
