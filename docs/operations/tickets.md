# 工单（Tickets）运维说明

> 状态：实现基线（2026-10-12）。本文只写本版已落地的操作；未实现的脚本与流程逐条标注，不写成可执行步骤。**服务端已注册全部 19 条路由**：组织项目开通/暂停/切换与成员目录、工单创建/列表/详情/修改、标签挂载、评论列表/创建/编辑、项目标签读写、操作账本查询与附件列表/上传/下载都已可用；409 `VERSION_CONFLICT` / `TICKET_OPERATION_PENDING` / `WRITE_NOT_APPLIED`、202 待确认与 `needs_review` 的处置口径在下文逐条给出。仍未实现的是恢复核对的周期扫描（核对目前只由操作查询被动触发）、事件同步与站内通知，见 [工单模块架构](../arch/29-tickets.md) §10。
> 权威来源：模块行为以 [工单模块架构](../arch/29-tickets.md) 为准；Git 连接配置、Forgejo 编排与共享库创建以 [公共 Git 运维说明](./common-git.md) 为准；编排与 feature 开关以 [Docker 编排体系](./docker-topology.md) 为准（本文不复述它们的细节）。

## 1. 组件与两层开关

| 组件 | 落点 | 开关 |
|---|---|---|
| 工单模块（`@fenix/resource-tickets`） | 主服务进程内的模块 | 应用装配：`deploy/assembly/ce-tickets.json` + `RCS_ASSEMBLY_PROFILE_PATH` |
| Forgejo（仓库与工单的事实源） | `docker/git/docker-compose.yml` 独立 Compose 项目 | 部署 feature：`docker/deploy.env` 的 `FENIX_FEATURE_GIT`（默认 false） |
| 五张工单表 | 共享 `postgres` 里主服务自己的库 | 无开关：DDL 迁移与装配无关，任何 profile 都可执行 |

工单模块**依赖** Git 模块：profile 必须同时列 `git` 与 `tickets`（`ce-tickets.json` 已经如此）。只列 `tickets` 会在启动期报「模块 tickets 依赖未启用模块 git」，不会静默降级。

两层开关互不自动映射：`FENIX_FEATURE_GIT=true` 只起 Forgejo 容器，不会让主服务加载工单；用 `ce-tickets.json` 启动也不会替你起容器。工单**不新增**任何环境变量与 `FENIX_FEATURE_*` 开关。

## 2. 启用步骤

1. **准备 Git 侧**：按 [公共 Git 运维说明](./common-git.md) §2–§4 部署并初始化 Forgejo、配好 `AOS_GIT_CONFIG_FILE` 连接文件与两枚 token。连接文件里 `connections[].id` 的值就是开通工单时要传的 `connectionId`。
2. **确认 DDL 已应用**：见 §4；表与模块开关无关，未启用工单的部署同样要迁移。
3. **构建含工单的浏览器产物**：
   ```bash
   bun run generate:web-contributions --profile deploy/assembly/ce-tickets.json
   bun run build:web
   ```
   产物只有一份：只改部署配置不会让旧 bundle 获得工单页面。生成物在版本控制内，默认门禁按 `ce.json` 的产物逐字比对，构建后如需回到默认产物运行不带 `--profile` 的 `bun run generate:web-contributions`。
4. **用含工单的装配启动主服务**：把 `RCS_ASSEMBLY_PROFILE_PATH` 指向 `ce-tickets.json` 的**绝对路径**（容器内是 `/app/deploy/assembly/ce-tickets.json`，源码运行用 `$PWD/deploy/assembly/ce-tickets.json`），重启生效。
5. **自检**：`GET /web/system/modules` 的 `data.modules` 含 `git` 与 `tickets`、`data.web` 含 `tickets`；控制台出现「工单」入口。任一不满足时先看排障表，不要用改前端的方式绕过。

## 3. 开通组织工单项目

开通是组织级管理动作，由组织 `owner` / `admin` 调用（`member` 会得到 403）；组织还没有项目时控制台列表页显示「尚未开通」，**不发任何工单请求**，这是预期行为。请求需要 `Idempotency-Key`（8–128 位字母、数字、下划线或短横线），一次用户动作一个键，重试复用同一个。

`create`（在凭据账号下新建私有仓库）：

```bash
curl -fsS -X POST "https://<host>/web/ticket-projects/default" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 9f2c7a1b4e6d" \
  -d '{"connectionId":"primary","mode":"create","repository":{"owner":"aos-service"}}'
```

`bind`（绑定既有仓库，`name` 必填，先按 `owner/name` 回源校验可访问）：

```bash
curl -fsS -X POST "https://<host>/web/ticket-projects/default" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 1b8e5d3a7c02" \
  -d '{"connectionId":"primary","mode":"bind","repository":{"owner":"aos-service","name":"aos-tickets-org"}}'
```

结果与后续动作：

- **200** `{ project, operation }`：项目已落库并成为该组织的默认项目。
- **202** `{ operationId, status: "uncertain" }`：上游写入结果未定，或本端已有在途/未定的写入（三种来源见 §6）。**不要重发**（同键重发只会再拿 202 或 409）；用 `GET /web/ticket-operations/:operationId` 复核，该接口只对发起人本人可见，其余一律 404，且**返回前会对未定状态执行一次回源核对**（只读远端、绝不重放写入）：确定已落库补成成功，确定未落库落 `failed`（同键重放得到 409 `WRITE_NOT_APPLIED`），仍判定不了且超过 15 分钟转 `needs_review`；核对时托管平台不可用返回 503，稍后重查即可。核对是**被动单次**的（只有查询触发），周期扫描未实现，确认前不要手工重复开通。
- **500（无业务码）**：`create` 模式下「远端已建出仓库、本地项目终态写入失败」会以未处理异常上抛，账本保持 `dispatching`。这**不等于远端没成功**：不要重发，先到 Forgejo 侧核对仓库是否已存在，再按 §6 的 `dispatching` 口径处置。（建工单的同类失败已收敛成 202，见 §6 的 202 行。）开通（`project.provision`）没有核对口径：查询账本行只会让它在超过 15 分钟后转 `needs_review`，不会给出「仓库到底建没建出来」的结论，仍需人工核对仓库与绑定记录。
- **409** `REPOSITORY_ALREADY_BOUND`：同名仓库存在但归属未确认（或绑定已归别的组织）。改用 `bind` 显式绑定；已被别的组织占用的绑定不会成功。
- **暂停与恢复**：`PATCH /web/ticket-projects/default`，body `{"status":"paused"}` 暂停组织工单（只停写、读取与历史保留），`{"status":"active"}` 恢复；不带 `defaultProjectId` 时作用在当前默认项目上，没有默认项目返回 404。该接口是数据库事务内的本地变更，不需要幂等键。
- **切换默认项目**：`PATCH` 传 `{"defaultProjectId":"<uuid>"}`；目标处于暂停状态时返回 409（先恢复为 `active` 再切换）。
- **开通自检**：`GET /web/ticket-projects` 的 `state` 应为 `ready`，并给出 `defaultProjectId`。

## 4. 迁移

- 本模块的迁移随主服务迁移链交付：`drizzle/0033_common-git-tickets-tables.sql`（与公共 Git 四张表同批一次交付，含五张表、索引与约束，以及在途互斥查询用的部分索引 `where status NOT IN ('succeeded','failed')`）。纯 DDL、无回填，对存量数据无影响。
- 索引用普通 `CREATE INDEX`（不是 `CONCURRENTLY`），执行期间会对 `ticket_operations` 取写锁；五张表随同一迁移新建、执行时为空，锁窗口可忽略。
- 执行：`bun run db:migrate`；生产入口是 `scripts/migrate.ts` 构建出的 `migrate.js`。迁移走 drizzle journal，对多实例并发启动幂等。
- 未启用工单的部署同样要执行这一步：表属于主服务的库，与装配无关；不迁移只会在启用后集中报错。
- 本次迁移是纯 DDL、无存量回填，**不跑** `bun run run-data-migrations`。
- 发布顺序固定 DDL → 数据 → 应用，不得颠倒。

## 5. 关闭与回滚约束

- **关工单、保留 Git**：启动 profile 换成 `ce-git.json`（只从 `resources` / `web` 移除 `tickets`，保留 `git`）。若浏览器产物仍含工单贡献，`data.web` 不再含 `tickets` ⇒ 入口隐藏、`/agent/tickets/*` 显示「未启用」、不发请求。
- **完全关闭**：换回 `ce.json`（同时不启用 Git 能力）；进程不读连接配置、零出站请求。
- **只动开关**：**不 drop 五张表、不删 Forgejo 仓库 / Issue / 评论 / 附件、不删项目与绑定记录**。`uncertain` 操作的 `intent` 原文与结果保留，恢复后按 `operationId` / `message_id` 核对。
- **不强行降级**：旧应用版本若读不懂新 schema，停止回滚、改用经过验证的前向修复，不得删数据强行降级。
- **重新启用**：确认产物含工单贡献（用 `ce-tickets.json` 生成并构建过）→ 启动 profile 指回 `ce-tickets.json` → 组织管理员确认项目状态。暂停中的项目**不会**因重新开通被悄悄恢复成默认，这是刻意的运维边界。

## 6. 排障

| 症状 | 定位 | 处置 |
|---|---|---|
| `/web/ticket-projects` 或 `/web/tickets/*` 一律 404 | 工单模块未装配（启动 profile 不含 `tickets`），或路由贡献未注册 | 看 `GET /web/system/modules`：`data.modules` 缺 `tickets` 就换用 `ce-tickets.json` 重启；已含 `tickets` 仍 404 说明请求打到了别的副本，核对滚动发布是否落在一致 profile 的后端集合 |
| 手工输入 `/agent/tickets` 显示「模块 tickets 未启用」 | 该 bundle 不含工单贡献（或服务端已关闭） | 默认 bundle 下是预期行为；要用的部署必须用 `ce-tickets.json` 重新生成贡献并重建 |
| 入口可见但接口 404，或服务端可用但界面没有入口 | 构建期 bundle 与运行期 profile 不一致 | 两者由同一份 `/web/system/modules` 对齐：重建产物或改启动 profile，不要在两处分别打补丁 |
| 写路径返回 202 `{status:"uncertain"}` | 三种来源：上游写入结果未定（`WRITE_UNCERTAIN`）；同一幂等键的并发或崩溃残留停在 `dispatching`；**远端已成功但本地终态写入失败**（建工单走这一支，开通走 500，见 §3） | **不重发**；`GET /web/ticket-operations/:operationId`（仅发起人）返回前会触发一次核对，结论直接体现在响应里。运维可直读 `ticket_operations`：`status=dispatching` 表示在途或崩溃残留、`step` 给出卡点（本版**全部登记取值都有写入方**：`dispatching` / `project_ready` / `index_written` / `upstream_failed` / `owner_mismatch` / `issue_updated` / `labels_updated` / `comment_created` / `comment_updated` / `upstream_applied` / `ownership_written` / `attachment_uploaded` / `needs_review` / `not_applied`）；核对失败时查询接口报 503，稍后重查即可；周期扫描未实现，长期无结论的仍要带 `message_id` 或预留仓库名到 Forgejo 侧人工核对 |
| 建工单返回 202，但 Forgejo 侧能看到那张工单 | 远端已建出、本地索引或归属未写完（账本停在 `dispatching`，`step` 为 `index_written` 之前） | **不重发**：同键重放只会再拿 202。先查询 `GET /web/ticket-operations/:operationId`：核对会按 `intent.since` 有界扫描命中该工单、补齐索引与归属并把账本收成 `succeeded`；扫描不到且超过 15 分钟转 `needs_review`，此时按账本行的 `message_id` 人工补齐本端索引与归属 |
| 写路径返回 409 `TICKET_OPERATION_PENDING` | 同一对象上还有未确认的变更（在途互斥）：`ticket_operations` 里存在 `target_id` 相同、`kind` 在本次声明的互斥组内且 `status NOT IN ('succeeded','failed')` 的行（`needs_review` 也算在途）。**会产生它的写路径是三条**：工单修改与标签挂载（组 `issue.update` / `issue.labels`，坐标是工单号，两者互相挡住）、评论编辑（组 `comment.update`，坐标是评论 ID，只挡同一条评论的另一次编辑）；评论创建、建工单、项目标签 CRUD 与附件上传不在任何互斥组内（并发评论、并发建单、并发传附件都不是冲突） | 先核对那笔未决操作：工单级互斥看详情页的 `pendingOperationId`，评论级互斥在 `ticket_operations` 里按 `target_id`（评论 ID）与未终结状态定位，核对口径见上一行；确认完成后重试。若那行已停在 `needs_review`，按下一行处置 |
| 账本里出现 `status = needs_review` | 恢复核对的结论之一：多次回源都判定不了，或（含没有核对口径的 `project.provision`）超过 15 分钟仍未找到匹配 | 交人工处理：处置前不要改动或删除该行，它保存着 `intent` 原文与核对记录（`result.steps[]`）。到 Forgejo 侧核对后，已落库的按实际结果收敛、确认没落库的引导用户换新 `Idempotency-Key` 重提；行本身由运维按现场手工收尾（周期扫描与 `intent` 清理尚未实现） |
| 写路径返回 409 `WRITE_NOT_APPLIED` | 该次修改经核对确认远端**没有**落库：账本行已落 `failed`，同一个幂等键重放时按原结论返回这个 409（对应的 `GET /web/ticket-operations/:id` 会显示 `status=failed`） | 换一个新的 `Idempotency-Key` 重提（不要复用原键） |
| 写路径返回 409 `IDEMPOTENCY_CONFLICT` | 同一个 `Idempotency-Key` 被用于不同请求内容（全部写路径共用这个判定） | 换新键重试；内容未变的合法重试应复用原键（会拿到原结果而不是重复创建） |
| 开通返回 409 `REPOSITORY_ALREADY_BOUND` | 同名仓库已存在但无法确认归属，或绑定已归别的组织 | 改用 `mode: "bind"` 显式绑定；确认目标仓库与绑定归属后再操作 |
| 写路径返回 503 `TICKETS_PAUSED` | 组织/项目被暂停 | 由管理员 `PATCH /web/ticket-projects/default` 传 `{"status":"active"}` 恢复；读取路径不受暂停影响 |
| 读或写返回 503 `GIT_UNAVAILABLE` / `GIT_RATE_LIMITED` | Forgejo 不可达、限流，或绑定被暂停 / `tickets` 消费者授权被收回 | 按 [公共 Git 运维说明](./common-git.md) §6 探活与处置；再核对绑定 `status` 与 `allowed_consumers.tickets`。读路径对可重放失败自动重试 2 次，写路径不重放。**故障注入的两种表现不同**：容器停止/重启中（连接被拒绝）走这条 503 快速失败——修改类写路径在写之前先回源读，读就先失败了，绝不会留下半截写入；只有**连接被挂住**（超时，例如容器 `pause` 或网络黑洞）才落到上面的 202 未定 |
| 上传附件返回 400 | 两类来源：**本地预检**（缺 `file` 字段、一次多文件、空内容、超过 10 MB、文件名归一后为空或超 200 字符）在发请求前拒绝，不回源也不消耗幂等键；**上游确定拒绝**（扩展名不在托管平台白名单 422、超过上游大小上限 413 → 账本已落 `failed`） | 本地预检：按提示换文件，同键可继续用。上游拒绝：换文件并**换新 `Idempotency-Key`** 重提（同键同内容重放会还原同一个 400，账本行已 `failed`，不要复用该键）。这条路径**不会**出 202：上游拒绝是确定结论，不做结果核对 |
| 上传附件返回 202 / 下载附件返回 404 / 附件接口返回 503 | 202 与其它写路径同源（见上面的 `uncertain` 行），差别只在核对判据：附件没有身份头，恢复核对按 `intent` 里的**文件名 + 字节数**在工单附件集合上认领；404 与列表、详情同形（附件编号在**该工单**的元数据端点下读取，不属于该工单时上游就是 404，不区分「不存在」与「不属于它」）；503 与 `GIT_UNAVAILABLE` 同源，**含读接口（列表、下载）的授权问题**——读路径不区分「`attachments.read` 被收回」与「平台不可用」 | 202：**不重发**，`GET /web/ticket-operations/:operationId` 触发核对——恰好 1 条同名同字节数收成成功，多条转 `needs_review`，**0 条保持未定**（附件可能仍在存储队列里，不凭暂时没有认定失败）。404：连工单号一起核对（工单不存在时列表端点同样 404）。503：按上面的 `GIT_UNAVAILABLE` 行处置，并核对绑定 `allowed_consumers.tickets` 是否含 `attachments.read`。**上传另有 403**（绑定暂停 / 缺 `attachments.write` / 归属不匹配，消息为「当前凭据无权上传附件」）：补授权或恢复绑定后再试 |
| 开通返回 400 `GIT_OWNER_MISMATCH` | `create` 建仓响应的 owner 与请求声明不一致（该账号下建不了） | 在凭据账号下建仓，或改用 `bind` 接管既有仓库；请求里的 owner 不会被当作授权依据 |
| 列表数据停在开通前、行级 `sync_status` 长期为 `ready` | 事件同步未实现，索引只由工单自身的创建与修改路径写入（标题、状态、负责人与标签随写路径同步） | 预期行为：在 Forgejo 侧直接新建或修改的工单不会出现在列表（详情可回源看到最新正文）。不要在启用前承诺「列表与仓库实时一致」 |
| 列表页提示「索引未同步到最新」 | 行级 `sync_status = stale` | 当前没有写入 `stale` 的代码路径；出现即说明运行了后续版本的同步逻辑，按该版本的口径处置 |
| 评论区永远没有「加载更早的评论」 | 上游评论端点不透出 `Link` 头（`lastCursor` 为 null） | **Forgejo 15.0.9 实测即如此**：该端点忽略 `page` / `limit`、只带 `X-Total-Count`，因此第 1 页就是整串——显示的是**全量且最新在前**（不是最旧一页），只是没有分页可翻。不要对外承诺「首屏只读 30 条」；长讨论串的读取成本见[工单模块架构](../arch/29-tickets.md) §9.4 与 §10.11 |

另有三个**只由写路径产生**的码，排障时按下面的定位处置：`VERSION_CONFLICT`（409，工单修改或评论编辑的版本比对失败——拿到的 `expectedVersion` 已不是远端当前版本，重新读取详情/评论后按最新 `version` 重提即可）、`ASSIGNEE_NOT_MEMBER`（400，修改时指定的负责人不是当前组织的有效成员，按成员目录当前值判定，离职或跨组织 id 一律拒绝）、`LABEL_UNKNOWN`（400，挂载的标签不属于该项目——先读项目标签列表取真实 id）。`TICKET_CHANGE_IN_FLIGHT` 与 `TICKET_OPERATION_PENDING` 是同一条规则的同一个码，前者只用于还原人工改库或早期版本写下的账本行。

## 7. 既有风险提示

1. **索引不完整**：本版列表只反映工单自身创建与修改路径写入的索引行（标题、状态、负责人与标签随写路径刷新），Forgejo 侧的后续改动与评论内容都不进来；面向用户的说明不要把它描述成「仓库的完整镜像」。
2. **未确认写入的核对是被动的**：202/`uncertain` 的账本行保留 `intent` 原文与 `message_id`，核对只在查询该操作时执行一次；周期扫描未实现，无人查询的行不会自己收敛（超窗口也不会自动转 `needs_review`）；这些原文也没有生命周期清理（长时间未决的行会一直保留原文），关闭与回滚都不得清除或改写这些行。
3. **幂等键由调用方持有**：管理面调用方必须按「一次动作一个键」使用；同键不同内容会被 409 拒绝，键格式不合规会在路由层直接 400。
4. **凭据与绑定是硬依赖**：写路径依赖 `AOS_GIT_SERVICE_TOKEN` 与绑定记录的 `credential_ref`；收回授权或暂停绑定会让读取报 503 而不是显示空列表——这是刻意设计，不要用「降级为空」掩盖。
5. **一个绑定只归一个组织**：跨组织共享仓库不在本版合同内，冲突报 409；需要共享时在各自组织新建项目并绑定不同仓库。
6. **控制台暂无管理面**：没有开通、切换默认与暂停的页面入口，本版只能用 §3 的接口操作，注意保留 `Idempotency-Key` 与调用记录。
7. **详情页缺两处筛选控件与一个管理入口**：列表只有关键词与状态两个控件，负责人/标签筛选（后端 query 参数已支持）没有界面；评论编辑入口只认作者，组织管理员虽然在后端被允许编辑他人评论，但界面上没有入口——需要时只能走 `PATCH /web/tickets/:projectId/:number/comments/:commentId`。
8. **在途互斥只覆盖三条写路径**：工单修改、标签挂载与评论编辑声明了互斥组（见 §6 的 `TICKET_OPERATION_PENDING` 行）；评论创建与建工单刻意不在组内，项目标签 CRUD 是管理员动作、只有组织级写锁。给这几条路径新增互斥组时要同步复查详情页的 `pendingOperationId` 提示与本文的处置口径。
9. **评论创建的未定行不会自行收敛**：评论域的核对只给出 `applied` / `ambiguous` / `unmatched`（评论修改另有 `not_applied`），**创建没有 `not_applied` 判定**——写请求超时且评论确实没落库时，账本会一直停在 `uncertain`，`GET /web/ticket-operations/:operationId` 反复核对也不会给结论。实测影响可控：评论创建不进互斥组，详情页的 `pendingOperationId` 也不含它，因此工单的其它写不受影响，用户换一条新评论即可（新操作、新键）。解除条件：给评论创建补「确定未落库」的判据（需上游 `since` 窗口外的可证明依据），或等周期扫描实现后由扫描收敛。
10. **附件没有本地索引，事实源只在托管平台**：附件挂在工单上（不是评论上），本端不建表、不缓存，列表与下载每次都回源，因此不存在「降级为空列表」这种观测——回源失败就是 503（见 §6）。关闭工单开关只从装配移除模块，**不删远端附件**（§5）；下载一律经本服务代理，响应里不含任何上游直链。单文件 10 MB 上限由服务端把关，每次最多 5 个、并发 2 个是前端的组合规则——直连 API 的调用方要自己拆请求与控并发。
