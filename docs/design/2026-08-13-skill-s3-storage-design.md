# Skill 存储迁移 S3 设计

> 来源：架构文档 Skills 章节待设计项（[06-config](../arch/06-config.md) §Skills） | 状态：目标设计（未实现）
>
> 版本规则以 [通用资源版本控制](../arch/07-versioning.md) 为准；Skill 领域边界以 [配置资源系统](../arch/06-config.md) §Skills 为准。

## 1. 背景与现状

当前 Skill 内容保存在本地文件系统（`SKILL_DIR`，默认 `./data/skills`），与 PostgreSQL 元数据分处两地：

```text
{SKILL_DIR}/{orgId}/{name}/         源目录（SKILL.md + 附属文件）
{SKILL_DIR}/{orgId}/{name}.zip      下发归档（手写 Store-method zip）
```

由此产生的结构性问题：

- **单机有状态**：多实例部署时内容不在共享存储，扩容/重建实例会丢失或分裂内容；
- **文件系统即协议**：`skill.ts` 编排层、`skill-fs.ts`、`launch-spec-builder.ts`、下载路由全部依赖目录布局、mtime 比较和本地归档重建；
- **原子性靠备份目录模拟**：`setSkill` 与 `importSkillDirectories` 通过 `mkdtemp` 备份 → 写入 → 回滚恢复实现补偿，复杂且只覆盖单机故障；
- **改名/迁移脆弱**：object 路径含 `name`，改名即断链；旧布局迁移（`migrate-skill-storage-by-organization`）已经历过一次布局变更。

## 2. 目标与非目标

**目标**：

1. Skill 内容全量迁移到 S3 兼容对象存储，本地文件系统不再承载内容（开发/测试环境同样要求 S3 可用，如 MinIO）；
2. 解决对象结构、上传/替换与失败补偿、PG 元数据与 S3 内容一致性、孤儿对象清理、下载授权与完整性校验、Agent 下发格式六项待设计问题；
3. 与 [07-versioning](../arch/07-versioning.md) 的版本模型预留兼容：锁定版本的内容对象不可回收。

**非目标**：

- 不实现版本控制本身（Skill 表的 resource_id/version 改造属于 07-versioning 的落地范围）；
- 不引入 S3 之外的存储后端抽象层（Bun 内置 `Bun.S3Client` 直接作为实现）；
- 不改变 Skill 的业务规则（名称校验、frontmatter 解析、跨组织共享、上传冲突策略等保持不变）。

## 3. 核心决策

| 决策 | 内容 | 理由 |
|------|------|------|
| D1 | 使用 Bun 内置 `Bun.S3Client`，不引入 AWS SDK / MinIO SDK 依赖 | Bun 1.3 原生支持 S3 兼容协议（AWS S3 / MinIO / R2 / OSS 等），`write` / `file` / `exists` / `stat` / `delete` / `presign` / `list` 齐全，零新依赖 |
| D2 | 每个 Skill 内容为**单个 zip 对象**，采用内容寻址 object key | 单一权威对象，原子替换，无多对象一致性；内容寻址（sha256）天然幂等，重复上传无副作用 |
| D3 | SKILL.md 的 frontmatter 与正文收敛到 PG（新增 `content` 列），S3 只保存下发归档 | 详情读取（`getSkill`）退化为纯 PG 读；PG 是引用真相，S3 是内容仓库，边界清晰 |
| D4 | object key 使用 `skillId` 而非 `name` | 改名不影响存储位置；`skillId` 是 PG 主键，天然稳定 |
| D5 | 写路径遵循「对象先行、指针后行」：先 PUT 新对象，再提交 PG 指针更新 | 保证任意时刻 PG 可见的 `objectKey` 都指向已存在对象，不变量成立 |
| D6 | LaunchSpec 直接下发 S3 presign URL，`/skills/:name/download` 兼容路由改为「验证 token → 302 presign」 | Agent 消费协议形状不变（`{name, url}`），服务端不再中转 zip 流量 |
| D7 | 孤儿对象由「删除路径尽力清理 + 定期 GC + 可选 S3 lifecycle 规则」三层兜底 | 孤儿对象只造成存储浪费，不造成正确性问题；GC 以 PG 全部版本行引用的 objectKey 并集为存活集 |
| D8 | 全量切换，`SKILL_DIR` 与本地 FS 实现删除，不保留双写或兼容层 | 遵循「删除优于兼容」；对外契约（`{name, url}` 下发协议）单独评估兼容 |

## 4. 存储模型

### 4.1 Object key

```text
skills/{organizationId}/{skillId}/{sha256}.zip
```

- 前缀 `skills/` 与 bucket 内其他用途隔离，GC 与 lifecycle 规则按前缀生效；
- `organizationId` 提供租户级前缀隔离（与列表/清理按组织过滤一致）；
- `skillId` 是 PG `skill.id`（uuid），改名不影响 key；
- `{sha256}` 是 zip 内容的 SHA-256（hex），同一内容重复写入命中同一 key，天然幂等。

### 4.2 内容寻址的版本语义

- MAX 工作版本每次保存生成新对象（内容变化时 sha 不同），旧对象进入可回收集合；
- 锁定版本（07-versioning 落地后）的 PG 行原样复制 `objectKey`，其对象**永不回收**；
- GC 存活集 = 所有 PG 行（MAX + 整数版本）`objectKey` 的并集。

### 4.3 大小上限

- 单 Skill 总内容 ≤ 10MB（zip 构建在内存完成，与现状 `createSkillArchiveBuffer` 一致）；
- 单文件 ≤ 5MB，文件数 ≤ 200；
- 上限在边界处校验（上传分组与 `setSkill` 入口），超限返回 `VALIDATION_ERROR`。

## 5. 数据模型变更

`skill` 表（`src/db/schema.ts`）新增列：

| 列 | 类型 | 说明 |
|----|------|------|
| `content` | `text not null default ''` | SKILL.md 完整原文（含 frontmatter），详情读取与元数据展示的权威来源 |
| `objectKey` | `text` | 当前内容对象的 key，`null` 表示内容未写入（仅存在于写入编排的中间态） |
| `contentSha256` | `text` | zip 内容 SHA-256，写入时计算，启动装配时校验 |
| `contentSize` | `integer` | zip 字节数，`stat` 快速校验用 |

不变量：

- **PG 可见的 `objectKey` 必须指向已存在且 sha 匹配的对象**（D5 保证）；
- `description` / `metadata` 保持现状（frontmatter 解析后的展示副本），`content` 为原文，二者由写路径同事务更新，禁止只更新其一；
- 启动装配遇到 `objectKey IS NULL` 或 S3 对象缺失/sha 不匹配，一律视为配置损坏，拒绝启动（与现状 `missing skill source` 同风格，见 `launch-spec-builder.ts:378`）。

## 6. 写路径编排

### 6.1 setSkill（创建/更新）

```text
1. 校验名称、frontmatter、大小上限
2. 内存构建 zip buffer，计算 sha256、size
3. PUT skills/{orgId}/{skillId}/{sha256}.zip（幂等）
4. PG 事务：
   a. 已存在：UPDATE content / objectKey / contentSha256 / contentSize / description / metadata
   b. 不存在：INSERT 行（objectKey 等一并写入）
5. 提交成功后，尽力删除旧 objectKey 对象（失败仅记日志，GC 兜底）
```

创建路径的 `skillId` 来源：INSERT 前先由 PG 生成（`defaultRandom`）或编排层先生成 UUID；PUT 使用该 id，PG 行提交失败时删除已 PUT 对象（补偿）。

失败补偿矩阵：

| 失败点 | 补偿 | 结果 |
|--------|------|------|
| PUT 失败 | 无副作用，直接返回错误 | 旧内容与 PG 均未动 |
| PG 事务失败 | 删除已 PUT 的新对象 | 旧内容与 PG 均未动 |
| 删除旧对象失败 | 记录日志 | 旧对象成为孤儿，GC 兜底 |

**不再需要**：备份目录（`createBackupDir` / `backupSkillDirs` / `restoreFromBackup`）、mtime 比较、失败后重建归档——S3 原子替换 + 内容寻址使「旧状态天然保留」。

### 6.2 importSkillDirectories（批量上传）

```text
1. 校验上传分组（保持现状 groupUploadFiles / 冲突检测 / 冲突策略）
2. 对每个待写入 skill：
   a. 内存构建 zip，计算 sha256
   b. 为新建行预生成 skillId；覆盖行复用已有 skillId
   c. PUT 对象
3. 对每个 skill 执行 PG upsert（与现状逐行 upsert 一致）
4. 任一步失败：
   a. 回滚已 upsert 的 PG 行（新建行 DELETE，覆盖行恢复旧值）
   b. 删除本次已 PUT 的对象
```

覆盖（overwrite）语义：新对象 PUT 成功后 PG UPDATE 原子换指针；旧对象不立即删除，交给 GC。冲突检测（`importSkillDirectories` 的 `existingConflicts` 逻辑）保持不变。

### 6.3 deleteSkill / deleteSkillById

```text
1. 校验 writable（保持现状 External skill is read-only）
2. PG DELETE 行（行内 objectKey 作为删除清单）
3. 尽力 DELETE 该对象；失败仅记日志，GC 兜底
```

PG 删除先于 S3 删除：即使 S3 删除失败，PG 无引用后对象即成为孤儿，不影响正确性。

## 7. 读路径

### 7.1 详情与列表

- `listSkills`：纯 PG（不变）；
- `getSkill` / `getSkillById`：纯 PG，`content` 列解析 frontmatter（复用 `parseFrontmatter` 纯函数），**不再读文件系统**；
- `skill-fs.ts` 中所有 `node:fs` 操作删除；保留纯函数：`assertValidSkillName`、`parseFrontmatter`、`buildSkillMd`、`normalizeUploadPath`、`groupUploadFiles`、`resolveImportPlan`、zip buffer 构建。文件收敛为纯内容函数模块（建议更名 `skill-content.ts`，路径函数 `getSkillSourceDir` / `getSkillArchivePath` / `getSkillMdPath` 等全部删除）。

### 7.2 启动装配（LaunchSpecBuilder）

替换 `buildSkillSpecs`（`launch-spec-builder.ts:369`）中的本地逻辑：

```text
1. 读 PG 行（保持 loadAgentSkills 顺序与缺失校验）
2. S3 stat(objectKey) 校验存在性与 size
3. 生成 presign GET URL（TTL 与启动窗口匹配，现状为 3600s）
4. 注入 launch spec 的 { name, url }
```

删除：`isSkillStale`、`resolveSkillArchivePath`、`buildSkillArchive` 调用与 mtime 比较。外部操作（S3 stat / presign）在 PG 一致快照读取完成后执行，符合 07-versioning §7。

### 7.3 下载路由

| 路由 | 现状 | 目标 |
|------|------|------|
| `GET /skills/:name/download?token=` | 读本地 zip 文件流 | 验证 HMAC token → 302 重定向 presign URL（短 TTL，5 分钟）。token 协议保留（对外契约，供旧 Agent 与外部调用方过渡） |
| `GET /web/config/skills/:name/download` | session 认证 + 动态构建 zip buffer | session 认证 + 权限校验 → 302 重定向 presign URL |

`skill-download-token.ts` 保留（HMAC 签名与验证不变，`RCS_API_KEYS` 用途不变）。LaunchSpec 不再走 token 中转，直发 presign URL。

## 8. 一致性与不变量

- **引用真相在 PG，内容真相在 S3**。PG 的 `objectKey + contentSha256 + contentSize` 是唯一引用指针；S3 对象没有 PG 引用即为孤儿。
- **对象先行、指针后行**（D5）：先 PUT 对象，再提交 PG 指针。任何 PG 提交点，指针指向的对象都已存在且内容匹配。
- **PG 事务边界内不含 S3 调用**：S3 操作在事务外执行，避免事务持有期间的外部延迟与失败（与 07-versioning §7 一致）。
- **元数据三副本**（`description` / `metadata` / `content`）同事务更新：禁止只更新 content 不更新 metadata 的入口。
- 删除与更新不追求跨存储原子：S3 侧失败只产生孤儿，由 GC 回收；PG 侧失败按 6.1 补偿矩阵回滚。

## 9. 清理与垃圾回收

三层兜底：

1. **路径内清理**：删除 skill、MAX 更新后旧对象，立即尽力 `DELETE`（失败仅日志）；
2. **GC 任务**（启动时或定时，推荐定时 + 启动各一次）：
   - `list` `skills/` 前缀（分页，`maxKeys` 批处理）；
   - 存活集 = PG 全部 `objectKey` 并集；
   - 前缀内不在存活集的对象 `DELETE`；
   - 加分布式锁或单实例执行（复用项目现有调度/锁能力），幂等可重入；
3. **S3 lifecycle 规则**（部署侧可选配置）：`skills/` 前缀对象超过 N 天删除——仅作为 GC 失灵的最终防线，不能替代 GC（锁定版本对象也可能被误删，因此 N 必须大于内容最长保留需求，**启用 lifecycle 前需评估版本化落地时间表**）。

GC 只删除对象，绝不触碰 PG 行；版本化落地后存活集 = 全部版本行的并集（§4.2）。

## 10. 配置

`src/env.ts` 新增（全量切换，必填；Bun.S3Client 显式传参创建，不依赖进程级 `S3_*` / `AWS_*` 环境变量读取）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `RCS_S3_ENDPOINT` | 是 | S3 兼容 endpoint（AWS `https://s3.{region}.amazonaws.com`、MinIO `http://localhost:9000` 等） |
| `RCS_S3_BUCKET` | 是 | bucket 名称 |
| `RCS_S3_ACCESS_KEY_ID` | 是 | 访问密钥 ID |
| `RCS_S3_SECRET_ACCESS_KEY` | 是 | 访问密钥 Secret |
| `RCS_S3_REGION` | 否 | AWS 场景 region（endpoint 已含 region 时可省略） |

`SKILL_DIR` 删除（`getGlobalSkillsDir` 及全部调用方一并删除）。密钥不得写入日志或错误响应。

## 11. 模块改造清单

| 文件 | 改造 |
|------|------|
| `src/services/skill-storage.ts`（新） | `S3Client` 单例（env 装配）、object key 构造、`putZip` / `statObject` / `deleteObject` / `presignGet` / `listPrefix`、sha256 计算 |
| `src/services/skill-fs.ts` | 删除全部 `node:fs` 与路径函数，保留内容纯函数（§7.1），更名 `skill-content.ts`，zip 构建函数保留（`buildSkillArchiveBuffer` → `createSkillArchiveBuffer` 语义不变） |
| `src/services/skill.ts` | 编排层改为 PG + S3（§6）；`_deps` 注入模式保留，注入面从 `skillFs` 换成 `skillStorage` |
| `src/services/launch-spec-builder.ts` | `buildSkillSpecs` 改 S3 stat + presign（§7.2），删除本地归档重建 |
| `src/routes/skills.ts` | token 验证后 302 presign（§7.3） |
| `src/routes/web/config/skills.ts` | 下载 handler 改 302 presign；其余接口签名不变 |
| `src/services/data-migrates/migrate-skill-storage-by-organization.ts` | 保留（布局归一仍在 S3 迁移前执行） |
| `src/services/data-migrates/migrate-skill-local-to-s3.ts`（新） | 本地 → S3 一次性迁移（§12） |
| `src/env.ts` | 新增 S3 变量，删除 `SKILL_DIR` |
| `src/db/schema.ts` | skill 表新增 4 列（§5），Drizzle 迁移 |

## 12. 数据迁移

新增启动迁移 `migrate-skill-local-to-s3`（在 by-organization 迁移之后执行）：

```text
1. 读全部 skill 行
2. 对每行：
   a. 本地目录存在 → 构建 zip buffer → 计算 sha → PUT → UPDATE 行（objectKey/sha/size/content）
   b. 本地目录缺失但 archive 存在 → 读 archive 文件 → PUT（sha 按文件内容）
   c. 两者都缺失 → 记录告警，行保持 objectKey NULL（启动装配将拒绝该 skill）
3. 幂等：objectKey 已非 NULL 的行跳过
```

迁移完成且验证通过后，本地 `{SKILL_DIR}` 目录由运维确认后手动删除（迁移本身不删除本地数据，保证可回滚窗口）。

## 13. 验证与测试

- 存储层单测（MinIO 本地实例或注入 mock client）：key 构造、幂等 PUT、stat/delete/presign、list 分页；
- 编排层测试（延续 `_deps` 注入模式，注入 mock storage）：setSkill 创建/更新/失败补偿矩阵（§6.1）；import 批量成功/部分失败回滚；删除；
- LaunchSpecBuilder：objectKey NULL / 对象缺失 / sha 不匹配 → 拒绝启动；presign URL 注入；
- 下载路由：token 无效 403、有效 302、跨组织共享可下载；
- GC：孤儿回收、锁定版本对象保留（版本化落地后）、幂等重入；
- 迁移：本地数据 → S3 全量/部分缺失场景、重复执行幂等。

现有 `src/__tests__/skill-*.test.ts` 系列中依赖本地 FS 行为的用例按新边界重写（属实施阶段工作项）。

## 14. 分阶段实施

按垂直切片交付，每片可测试、可回滚：

1. **S1 存储层与配置**：`skill-storage.ts` + env + schema 迁移（新增 4 列）→ 验证：存储层单测、迁移可执行；
2. **S2 读路径**：详情读 PG `content`、下载路由 302 presign、LaunchSpecBuilder 切 S3 → 验证：现有读路径测试改写后全绿、启动装配拒绝损坏 skill；
3. **S3 写路径**：setSkill / import / delete 改编排 → 验证：补偿矩阵与批量回滚测试；
4. **S4 迁移与清理**：local-to-s3 迁移、GC 任务、删除 `skill-fs.ts` FS 残留与 `SKILL_DIR` → 验证：迁移测试、GC 测试、`precheck` 全绿。

每片完成后运行 `bun run precheck`；S4 后本地目录删除属运维动作，单独通知。

## 15. 风险与回滚

- **presign URL 泄露风险**：URL 即短期凭据。TTL 取启动窗口最小值（3600s），日志不得输出完整 URL（打点只记 skillId）；
- **S3 服务不可用**：写路径直接失败（无本地兜底），读详情不受影响（PG），启动装配失败——与「配置了远程 machine 但未连接」的失败哲学一致，不静默降级；
- **迁移回滚**：迁移不删本地数据；上线后出现 S3 写入异常可回滚到旧版本（本地数据仍在），回滚窗口由运维确定；
- **lifecycle 规则误删锁定版本对象**：启用前必须完成版本化落地评估（§9），否则禁用该规则。

## 16. 关联文档更新

以下文档联动已完成：

- [06-config](../arch/06-config.md) §Skills：状态已改为「已设计（未实施）」，链接本文档，删除「待重新设计」标注；
- [07-versioning](../arch/07-versioning.md) §9：已补充 Skill 内容对象的引用语义（`objectKey` 随版本行复制，锁定版本对象不可回收），§2.1 落地清单已收录 Skill 的内容对象列。
