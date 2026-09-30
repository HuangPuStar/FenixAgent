# ADR: workflow-v2 以 iframe + BFF 票据接入上游工作流引擎

- **日期**：2026-09-29
- **状态**：✅ 已确认（设计 §1.4 与 §5.6 的决策登记；实现进行中，进度见设计 §7 与任务清单）

## 背景

自研 workflow 前端（`packages/resources/workflow/web`，约 100 文件 / 1.7 万行）与基于 `@xyflow/react` 的画布已到能力与体验上限；上游工作流引擎（外部仓库 `/Users/konghayao/code/ai/workflow-studio`）提供成熟的画布（FlowGram）、节点体系、调试运行、版本发布与运行 trace，且其 Go 服务自带前端静态资源。

本次决策：删除我方全部 workflow 前端界面，新增 `workflow-v2` 模块转接上游的 workflow 能力——控制台用 iframe 嵌入上游画布页，画布内请求经同源反代**透传**给 workflow-v2，由 workflow-v2 以平台身份转接上游后端。架构细节见 [25-workflow-v2](../arch/25-workflow-v2.md) 与[设计文档](../design/2026-09-29-workflow-v2-upstream-studio-bridge.md)。

## 决策

### 1. 集成形态：iframe + 同源反代 + BFF 票据

**不拷贝上游前端源码进本仓，不做 Module Federation。**

- 拷贝源码等于承接其 20+ 子包、生成式 IDL 与内部设计系统的完整构建链与全部升级成本，与「删除自研前端以收敛维护面」的目标相悖。
- Module Federation 要求跨仓 lockstep 共享 React 与构建版本，运行时契约脆弱；且它无法约束子应用的网络行为——票据与参数注入必须在服务端收口，形态选择绕不开这一点。
- 同源反代（`/workflow-canvas/*` 落在控制台域下）带来三个直接收益：无 CORS、控制台会话 cookie 同站可用、票据只走请求头最简单。代价落在反代本身：上游除静态白名单外全站经 session 中间件，静态反代必须**出站**注入平台账号会话，同时**入站**剥离上游 `Set-Cookie`（两个方向不可混为一谈）。

### 2. 上游侧当黑盒：只改 `frontend/**`，不动 Go 后端，只用现成 HTTP API

- 不 fork 上游后端，避免合并成本与二次分叉；升级影响面收敛在「前端契约 + 透传参数」两处，可用契约快照做回归基线。
- 代价与已知边界：上游响应形状不统一（裸对象 / `data` 包裹 / 非 JSON panic）、失败编码多样（HTTP 200 + 业务码、400、401、500 纯文本）。因此透传**原样回传**，只在两处必要例外汇总改写：panic 文案脱敏、存储直链改写；差异逐条登记在[契约快照](../design/2026-09-29-workflow-v2-upstream-contract-snapshot.md)。

### 3. 租户 → App（bot）映射：organization 1:1 App，workflow 挂在 App 下

- App 是上游侧唯一的资源物理边界——workflow 的 `project_id` 就是它，且 `workflow_list` 的 `project_id` 是硬过滤（不传则挂在该 App 下的 workflow 完全不出现）。不映射则所有租户的 workflow 混在平台空间里，无法分租户分页。
- 不用「每用户一个 App」：App 数量随用户数增长，而上游 **没有「按空间列 App」的接口**（`space/list` 的 `app_ids` 恒为 `null`），数量失控后无法盘点。
- 平台整体只用一个上游用户与个人空间：接入面只维护一条会话；代价是该账号**单会话**（重登踢旧键），多副本必须共享会话来源。

### 4. 归属真相源放本地注册表，不依赖上游校验

- 上游的 `checkUserSpace` 只证明「平台账号属于该 space」，**不校验 workflow ↔ App 归属**，也不表达我方用户；跨租户隔离若依赖它等于没有隔离。
- 因此 `workflow_v2_workflow` 是归属的唯一真相源：所有带 `workflow_id` 的请求先校验「存在 + 属于当前组织 + 有权」，未命中统一 404（不泄漏存在性）；上游参数（`space_id`/`project_id`/`bot_id`/`owner_id`/`login_user_create`/`creator`/`operator`）一律由服务端注入并 strip 客户端同名值。
- 这是安全边界而非实现细节：后续新增任何透传路径，都必须先回答「归属由谁判定」。

### 放弃条件与迁移路径

**放弃条件**（触任一条即回到设计评审，改用其它形态或更换方案）：

1. 出现必须与宿主共享 React context / DOM 的深度交互；
2. `bind` / `refresh` 握手失败率长期 > 1%；
3. 上游前端无法完成必要裁剪（登录闸门、壳裁剪、basename 与资源前缀）。

**迁移路径**：① 同源反代 + 票据（本次）→ ② 拆子域 + 强 sandbox + CORS（需要更硬隔离时；显式 origin 白名单、`credentials:false`、仅收 header 票据）→ ③ 若深度集成确有必要，把上游的 workflow 包以 npm 依赖引入本仓，**BFF 与票据协议不变**，iframe 退化为降级路径。

## 考虑过的替代方案

| 方案 | 结论 |
| --- | --- |
| 把上游前端源码拷进本仓 | ❌ 承接 20+ 子包与生成式 IDL 的构建链与全部升级成本，与「删除自研前端」的目标相悖 |
| Module Federation 运行时组合 | ❌ 跨仓 lockstep 共享 React / 构建版本，契约脆弱；子应用网络行为不受控，票据与注入仍需服务端 |
| 自研画布继续演进 | ❌ 即本次被替换的现状，能力上限与维护面既定 |
| 每用户一个 App，或全局单 App | ❌ 前者 App 数量失控且无接口盘点；后者丢失租户物理边界，`project_id` 过滤失效 |
| 归属校验交给上游（只靠 space 成员关系） | ❌ 不构成多租户隔离：平台账号能读到该空间下任意租户的 workflow |
| 把上游 workflow 包作为 npm 依赖直接引入 | ⏳ 迁移路径第 ③ 步，仅在放弃条件触发时启用 |

## 后果

**积极后果**：自研 workflow 前端可整块下线，界面维护面收敛为列表页 + 宿主页；编辑、调试、发布与 trace 直接复用上游；平台凭据不出 workflow-v2，租户隔离判定集中在一处（本地注册表）。

**风险与缓解**：

| 风险 | 缓解 |
| --- | --- |
| 上游升级导致契约漂移 | 固定镜像 digest；升级前重跑 `scripts/workflow-v2/upstream-contract-probe.ts` 与契约快照逐行比对；按组织灰度 |
| 平台账号单点（全平台 workflow 依赖一条会话） | 主动探活 + 单飞自动重登 + 告警；只读降级到本地元数据视图；多副本共享会话来源（~~未落地~~ **已落地（2026-09-29，4B）**：会话权威副本在共享存储 Redis + 登录租约，见 [25-workflow-v2](../arch/25-workflow-v2.md) §6 第 6 条） |
| iframe 同源共享 origin，sandbox 不构成安全边界 | 真实边界 = CSP `frame-ancestors` + 短 TTL 可撤销票据 + BFF 归属校验 |
| 归属校验遗漏 → 跨租户越权 | 校验集中在 Facade 与透传入口；用例覆盖伪造 `space_id`/`project_id` 与跨租户 `workflow_id`（一律 404） |
| 反代路由顺序错误（透传请求被静态反代吞掉） | 声明序固定 `bff` 先于静态反代，并纳入部署检查清单 |
| 存储直链改写成为长期特例 | 只按已知 origin 前缀替换、不做泛化；代码内注明移除条件（上游可配置对外存储域即删） |

## 相关文档

- 设计与契约：[设计](../design/2026-09-29-workflow-v2-upstream-studio-bridge.md)（§1.4 决策摘要、§5.6 方案取舍）、[接口冻结](../design/2026-09-29-workflow-v2-interface-freeze.md)、[契约快照基线](../design/2026-09-29-workflow-v2-upstream-contract-snapshot.md)
- 架构：[25-workflow-v2](../arch/25-workflow-v2.md)、[17-workflow](../arch/17-workflow.md)（自研引擎，服务端保留）
- 任务：[Workflow V2 实施任务清单](../design/2026-09-29-workflow-v2-task-list.md)
