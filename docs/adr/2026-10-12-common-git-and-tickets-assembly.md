# ADR：公共 Git 独立 common 类别，并以可选装配槽接入

- **日期**：2026-10-12
- **状态**：**已接受**；决定 1–3 已实施（T01 交付 `@fenix/git`、`ce-git.json` 与 `docker/git/`），决定 4 为既定方向、**尚未实施**
- **关联**：架构 [公共 Git 模块](../arch/28-common-git.md)、运维 [公共 Git 运维说明](../operations/common-git.md)、部署契约 [Docker 编排体系](../operations/docker-topology.md) §6 / §13、既有裁定 [装配 profile 派生的前后端模块启用标识](./2026-10-08-assembly-capability-gate.md)

## 背景

平台需要一层公共 Git 接入：仓库、Issue、评论、标签的事实源放在 Forgejo，AOS 侧只保存绑定、订阅、事件与投递账本；第一批消费者是普通工单模块（工单正文与状态留在 Forgejo，AOS 只放索引与通知），后续还会有其他业务复用同一份托管平台能力。

决策前有三个约束同时成立：

1. 这份能力**被多个上层共用**，而它自己不依赖任何业务领域——仓库绑定、作用域客户端、错误码都不含工单语义。
2. 仓内已有的包类别是 `platform/*`（契约与有状态平台实现）、`agent-runtime`、`resources/*`（业务资源）与独立 SDK/插件包，**没有承载「被资源反向依赖的公共能力」的位置**。
3. 装配与部署已经有两套成熟机制：构建期的 assembly profile（`deploy/assembly/*.json` + `RCS_ASSEMBLY_PROFILE_PATH`）与部署期的 feature 开关（`docker/deploy.env` 的 `FENIX_FEATURE_<NAME>`，一个开关对一个依赖目录），方案明确不建设运行时插件市场或热插拔。

## 决策

1. **公共 Git 落在 `packages/common/` 这一独立类别**（首个成员 `packages/common/git`，包名 `@fenix/git`），而不是放进某个 `resources/*` 包或 `platform/*`。
   理由：它被宿主装配、被多个上层消费者依赖，而 `common` 的依赖方向是**只向下**——`scripts/lib/architecture-boundary-rules.ts` 为 `common` 声明的禁则覆盖 `platform-impl` / `agent-runtime` / `machine` / `sandbox` / `resource` / `apps-server` / `apps-web`，只允许平台契约（`platform-sdk`）与独立工具包。放进任何资源包都会迫使其他消费者反向依赖那个包的领域实现，直接闭合出环；放进 `platform/*` 则名不副实：它不提供授权或身份语义，也不属于最底层契约。
2. **Git 能力用现有 assembly 可选槽注册**：manifest `id = "git"`、`kind = "resource"`、`dependsOn: []`；`deploy/assembly/ce.json` **不含** git，启用面单独放在 `deploy/assembly/ce-git.json`。不新增模块类别、不引入第二套注册机制、不引入运行时插件市场。
   理由：装配已经是「构建期选择、运行期只能收窄」的唯一真相源（bundle 是上界），再加一套动态注册会与它争夺同一件事的解释权；用现有槽位还能自动获得 profile 校验、`/web/system/modules` 能力发现与生成物守卫。
3. **Forgejo 作为共享外部依赖，由 `FENIX_FEATURE_GIT` 独立编排**（`docker/git/docker-compose.yml` 独立 Compose 项目，默认关闭），与 assembly 的启用**相互独立、不自动映射**。
   理由：Forgejo 是多个消费者共用的外部服务，生命周期由部署层持有；关掉工单不等于可以停 Forgejo，起 Forgejo 也不等于某个 AOS 进程启用了 Git 能力。「两层开关不自动映射」是既有通用口径，本决定只是把它套到本模块上。
4. **工单模块（T02+）是 Git 的消费者、默认关闭**：`@fenix/resource-tickets` 的 `dependsOn` 含 `git`，经 `GitService.createScopedClient` 取受控作用域，启用面由 `ce-tickets.json` 决定；git 不依赖工单、不理解工单与通知语义。
   理由：依赖方向一旦反过来（git 认识工单），公共层就无法再被第二个消费者复用。**本条是既定方向，工单包、工单表与页面在本 ADR 落笔时均未实现**。

## 考虑过的替代方案

| 方案 | 结论 |
|---|---|
| 放进第一个消费者的资源包（如 `resources/tickets`） | ❌ 其他消费者必须反向依赖工单包的领域实现，且第二个消费者出现时必然产生环；公共能力会被迫接受消费者语义 |
| 放进 `platform/*`（`platform-sdk` 或新增平台实现） | ❌ 它不是平台契约，也不是有状态的授权/身份实现；放进去会让平台层承担外部服务适配，模糊「平台契约向下、业务向上」的方向 |
| 新增模块 `kind` 或第二套运行时注册机制 | ❌ 现有 assembly 槽已能表达「可选、构建期、可回滚」，另起一套只会产生两份启用面；方案明确排除运行时插件市场与热插拔 |
| 让 `FENIX_FEATURE_GIT` 与 assembly 自动联动 | ❌ 同一个 Forgejo 服务被多个消费者共用，部署开关无法推断「谁还需要它」；自动联动会把共享服务的生命周期绑到某一个模块上（见既有 ADR 的同名结论） |
| 默认装配即包含 git | ❌ 会让不接入托管平台的部署白读配置、白建连接；默认关闭 + 显式 profile 才能保证「未启用即零出站请求」 |

## 后果

- 需要维护一份新的类别边界规则与文档矩阵：`scripts/lib/architecture-boundary-rules.ts` 的 `common` 禁则已生效；**`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §2.3 的包类别依赖矩阵尚未登记 `common` 行**，需由维护者补，否则规范与门禁实现不一致。
- `common` 类别会被后续能力「顺手放进来」：判据是**被多个上层复用且不依赖任何资源领域**，单一消费者专用的能力仍应放进它自己的资源包。
- 新增两个开关位需要运维理解：装配层（`ce-git.json`）与部署层（`FENIX_FEATURE_GIT`）都要显式打开才有可用功能；两者都不做自动联动，代价是操作步骤多一步，收益是共享 Forgejo 不被单个消费者绑死。
- 工单默认关闭意味着含工单的浏览器 bundle 必须单独构建（`bun run generate:web-contributions --profile …` + `bun run build:web`）；只改服务端配置不会让旧 bundle 获得工单页面。
- 回滚只动装配与容器开关：换回 `ce.json`、`FENIX_FEATURE_GIT=false`，**不 drop 四张账本表、不删除 Forgejo 仓库**；未确认的写入（`WRITE_UNCERTAIN`）按 `operationId` 与消息标识回源核对，不随回滚清除。
