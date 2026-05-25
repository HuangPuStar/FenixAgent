# Feature: 20260520_F001 - skill-launch-download

## 需求背景

当前 `src/services/launch-spec-builder.ts` 在构建 `AgentLaunchSpec` 时固定返回 `skills: []`，导致 AgentConfig 中已经可用的 skill 不会进入 core/opencode runtime。根因不是查询不到 skill：`getAgentFullConfig()` 已经会返回团队全局 skill 和 agent 专属 skill；真正缺口是 `plugin-sdk` 的 `SkillConfig` 只接受 `{ name, url }`，而 RCS 当前只保存本地 `contentPath`，没有可供 opencode runtime 下载的 zip URL。

同时，skill 仍默认写入 `~/.agents/skills`，这不利于服务端部署、容器挂载和备份。需要把 skill 存储调整到服务端数据目录，并在创建、更新、上传导入后同步生成 zip 产物，让 `buildLaunchSpec` 能把可下载 URL 填入 `skills[]`。

## 目标

- 将全局 skill 的存储根目录从 `~/.agents/skills` 改为可配置的 `SKILL_DIR`，默认 `./data/skills`。
- 全局 skill 每次文本创建、编辑、文件夹上传或覆盖导入成功后，都生成对应 zip 包。
- 提供后端 skill zip 下载 URL，供 opencode runtime 通过 `fetch(skill.url)` 下载。
- `buildLaunchSpec` 根据 `fullConfig.skills` 填充已启用 skill 的下载 URL。
- 保持现有 Skills 页面文本创建、文件夹上传、启用/禁用、删除能力不回归。

## 方案设计

### 一、推荐方案

采用“RCS 管理 skill 源目录 + 同步生成 zip artifact + 后端受控下载 URL”的方案。

具体形态：

- `SKILL_DIR` 是全局 skill 数据根目录，默认指向项目运行目录下的 `./data/skills`。
- 每个 skill 的源目录仍是一个独立目录：`${SKILL_DIR}/<skillName>/`。
- 每个 skill 的 zip 产物写到：`${SKILL_DIR}/<skillName>.zip`。
- PG `skill.contentPath` 继续保存 `SKILL.md` 路径，路径变为 `${SKILL_DIR}/<skillName>/SKILL.md`。
- 新增下载路由返回 zip 文件，例如：`GET /web/skills/:name/download`。
- `buildLaunchSpec` 使用 `getBaseUrl()` 拼出绝对 URL，例如 `${getBaseUrl()}/web/skills/${encodeURIComponent(name)}/download`。

这个方案不扩展 `plugin-sdk`，也不要求 `plugin-opencode` 支持本地 path，能复用当前已经实现的 zip 下载与解压逻辑。

不推荐直接把 `SkillConfig` 扩展成 `{ path }`：这会把服务端本地文件系统路径泄漏到 engine 层，后续 remote node 或容器隔离场景会再次失效。

### 二、存储目录设计

新增环境变量：

```text
SKILL_DIR=./data/skills
```

在 `src/env.ts` 中声明，在 `src/config.ts` 中暴露为 `config.skillDir`。相对路径按服务进程 CWD 解析，保持与 `./data` 这类部署目录一致；实现时使用 `resolve()` 规范化，避免不同模块拼接出不同路径。

目录结构：

```text
data/skills/
  code-review/
    SKILL.md
    references/
    scripts/
  code-review.zip
```

命名和安全约束：

- skill 名称禁止 `/`、`\`、空字符串、`.`、`..`。
- 下载路由必须校验 token 签名、有效期和 skillName 匹配，不能直接按路径读任意文件。
- zip 生成只包含 skill 目录内文件，不能跟随路径穿越到目录外。

### 三、zip 生成策略

在 `src/services/skill-fs.ts` 增加纯文件系统能力：

- `getSkillSourceDir(skillRoot, name)`：返回 `${skillRoot}/<name>`。
- `getSkillArchivePath(skillRoot, name)`：返回 `${skillRoot}/<name>.zip`。
- `buildSkillArchive(sourceDir, archivePath)`：把 sourceDir 下所有文件打成 zip。
- `deleteSkillArchive(skillRoot, name)`：删除对应 zip。

实现优先使用 Bun/Node 可稳定执行的方式。若继续依赖系统 `zip` 命令，需要在实现计划中明确测试环境要求；更稳妥的实现是新增轻量 zip 库或使用项目已有依赖能力，避免生产机器缺少 `zip` 命令。

触发点：

- `setSkill()` 写入 `SKILL.md` 成功后生成 zip。
- `importSkillDirectories()` 写入上传目录并完成 PG upsert 后生成 zip。
- `overwrite` 导入失败回滚时，需要恢复源目录并重新生成旧 zip，或删除本次失败生成的 zip。
- `deleteSkill()` 删除 PG 和源目录后同步删除 zip。
- `disableSkill()` 不删除 zip；是否进入 launch spec 由 `enabled` 控制。
- `enableSkill()` 可在启用前检查 zip 是否存在，不存在则从源目录补生成，提升历史数据兼容性。

zip 生成应尽量放在同一服务层事务语义内：文件写入、zip 生成、PG 写入任一步失败，都要清理本次新增文件，避免出现“列表中有 skill，但下载 404”的状态。PG 目前没有包裹文件操作的数据库事务，本设计沿用现有备份/回滚策略，在服务层保证最终一致。

### 四、下载 URL 与路由

新增后端路由建议放在 `src/routes/web/config/skills.ts` 或拆出 `src/routes/web/skills.ts`：

```http
GET /web/skills/:name/download
```

该路由暂不支持浏览器 session 下载，只支持 token 下载。原因是 opencode runtime 的 `fetch(skill.url)` 不带浏览器 cookie，当前只需要满足 runtime 后台下载。

下载 URL 形态：

```text
/web/skills/:name/download?token=<signed-token>
```

token 设计：

- 由服务端基于 `RCS_API_KEYS` 或 JWT secret 签名。
- payload 至少包含 `skillName`、`exp`。
- 默认有效期建议 30 分钟，足够 `prepareEnvironment()` 下载。
- 下载路由只校验 token 签名和有效期；`name` 参数必须与 token 中的 `skillName` 一致。
- 下载路由不挂 `sessionAuth`，也不依赖浏览器 cookie。

这样既满足 runtime 后台下载，也避免把 skill zip 做成完全公开资源。

下载响应：

- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="<skillName>.zip"`
- 不存在、未启用或 token 无效/过期时分别返回 404/403。

### 五、buildLaunchSpec 接入

`buildLaunchSpec()` 当前已拿到 `fullConfig.skills`。新增映射逻辑：

```ts
const skills = fullConfig.skills
  .filter((skill) => skill.enabled)
  .map((skill) => ({
    name: skill.name,
    url: buildSkillDownloadUrl(skill.name, {
      expiresInSeconds: 3600,
    }),
  }));
```

然后返回：

```ts
return {
  workspace: workspacePath,
  agent,
  model,
  skills,
  mcpServers,
};
```

边界：

- 只加入 PG 中的全局 skill 和 agent 专属 skill，即 `getAgentFullConfig()` 返回的 `fullConfig.skills`。
- `enabled = false` 的 skill 不进入 launch spec。
- workspace skill 暂不进入 launch spec。workspace skill 当前是按环境目录扫描的本地能力，和 AgentConfig 可用 skill 不是同一来源；若后续要支持，需要单独设计“环境级 skill 注入”。
- 若某个已启用 skill 缺少 archive，`buildLaunchSpec` 可以调用服务层确保生成，或在 skill 写入阶段保证 archive 必然存在。推荐后者，`buildLaunchSpec` 保持轻量，只在缺失时记录错误并跳过或抛错。为避免静默缺 skill，建议抛出 `CONFIG_READ_ERROR` 或 `VALIDATION_ERROR`。

### 六、历史数据与迁移

不做历史数据迁移。

原因是该能力尚未上线，不需要兼容旧 `~/.agents/skills` 或 `~/.config/opencode/skills` 中的历史目录。实现时可以移除或停止调用旧的 `migrateSkillsDir()` 迁移逻辑，让新创建、编辑、上传导入的 skill 全部落到新的 `SKILL_DIR` 结构中。

### 七、测试设计

后端测试重点：

- `SKILL_DIR` 默认值和 env 覆盖生效。
- `setSkill()` 写入 source 目录并生成 archive。
- 文件夹上传导入成功后生成 archive。
- overwrite 失败能恢复 source，并保证 archive 不残留错误版本。
- delete 删除 source 和 archive。
- disable 后 `buildLaunchSpec` 不包含该 skill。
- `buildLaunchSpec` 对 enabled global skill 和 agent-scoped skill 填入下载 URL。
- 下载路由 token 正确时返回 zip，token 错误、过期或 skillName 不匹配时拒绝。

插件侧不需要改行为，但可补一个集成测试确认 `plugin-opencode` 能继续下载 RCS 提供的 zip 并解压到 `.opencode/skills/<name>`。

## 实现要点

- 新增 `SKILL_DIR` 环境变量必须先改 `src/env.ts`，再改 `src/config.ts`。
- `src/services/skill.ts` 中的 `SKILLS_DIR` 不应继续是 `join(homedir(), ".agents", "skills")` 常量，应由配置派生。
- `skillContentPath()`、导入目标目录、列表 source path 都要统一使用 `${SKILL_DIR}` 根目录下的 `<skillName>/SKILL.md`。
- `skill-fs.ts` 新增 zip 生成与 artifact 删除能力，业务编排仍留在 `skill.ts`。
- 下载 URL 生成建议做成小工具函数，例如 `buildSkillDownloadUrl()`，供 `launch-spec-builder.ts` 调用。
- 下载路由不能直接信任 `name` 参数拼路径，必须先校验 token 签名、有效期以及 token 内的 `skillName` 与路径参数一致，再读取 archive 路径。
- 修改前端代码不是本 feature 的核心，现有上传和文本编辑 API 可保持不变。
- 修改前端相关代码后仍需执行 `bun run build:web`；本设计主要是后端和 runtime launch 行为。

## 验收标准

- [ ] `SKILL_DIR` 可通过 env 配置，默认使用 `./data/skills`。
- [ ] 新建或编辑全局 skill 后，`contentPath` 指向 `${SKILL_DIR}/<name>/SKILL.md`。
- [ ] 新建、编辑、上传导入、覆盖导入成功后，`${SKILL_DIR}/<name>.zip` 存在且内容可解压出完整 skill 目录。
- [ ] 删除全局 skill 后，source 目录和 archive zip 都被清理。
- [ ] 禁用 skill 后不会进入 `AgentLaunchSpec.skills`。
- [ ] 启用的全局 skill 和 agent 专属 skill 会进入 `AgentLaunchSpec.skills`，每项包含可下载 URL。
- [ ] opencode runtime 能通过该 URL 下载 zip 并安装到 workspace `.opencode/skills/<name>`。
- [ ] 下载路由只支持 token 下载，校验签名、有效期和 skillName 匹配。
- [ ] 不执行旧 `~/.agents/skills` 或 `~/.config/opencode/skills` 的历史迁移逻辑。
- [ ] 后端相关测试、`bun run typecheck` 通过。
