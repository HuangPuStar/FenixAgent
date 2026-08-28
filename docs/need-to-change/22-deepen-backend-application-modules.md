# 22. 把业务编排从 route/repository 反向依赖中收进深 Application Module

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高，静态扫描与 deletion test 一致 |
| 影响 | 事务/授权/补偿规则散落、入口行为漂移、测试必须装配全栈 |

## 对抗判决

文档规定 `routes -> services -> repositories -> db`，当前却有 5 个 route 直接 import DB、11 个 route 直接 import repository、27 个 service 直接 import DB，3 个 repository 反向 import service。Workflow 的 run 编排在 `workflow-engine.ts`、`workflow-runs.ts`、`workflow-execute.ts` 重复。route 不再是协议 adapter，而是业务生命周期所有者。

## 已核验证据

- 反向依赖：`src/repositories/workflow-def.ts:19`、`src/repositories/environment.ts:5`、`src/repositories/organization-member-repository.ts:4`。
- 代表性 route 直连：`src/routes/web/workflow-engine.ts:11-19`、`src/routes/web/workflow-runs.ts:12-20`、`src/routes/web/knowledge-bases.ts:8`。
- `src/routes/web/workflow-runs.ts:97-163` 同时做 YAML 解析、启动、DB 回写、SSE、实例清理和错误映射。
- 相对路径依赖扫描发现 7 个源码环，包括 `acp-idle-monitor -> instance -> orchestration-instance -> acp-ws-handler` 及多条 bootstrap/sandbox/registry/file-transport 环。
- 81 个审计范围文件超过 500 行；行数不是根因，但与职责混合高度重合。

## 架构诊断

当前很多“service”只是函数文件，并未提供比 implementation 更小、更稳定的 interface。Repository 又依赖 workspace resolver/phone/workflow FS 等 service，持久化 adapter 获得领域外副作用。低 depth、低 locality 使每个入口复制同样的事务、错误和清理条件。

## 目标方向

- 优先围绕真实业务命令建立深 Application Module：WorkflowRun、AgentConfiguration、KnowledgeLifecycle、TenantProvisioning。
- route 只做认证后的协议校验、调用 command/query 和响应映射；未知异常交统一错误边界。
- Application Module 拥有事务、授权、幂等、外部副作用编排和领域事件。
- Repository 只接受持久化 DTO/scoped identity，不 import service/route/transport；基础纯函数下沉到无层级依赖模块。
- read-heavy 视图可以有 query adapter，不强迫所有读取走聚合，但租户/授权不变量不可绕过。

## 分阶段整改

1. 用 deletion test 选 seam：先迁移 WorkflowRun 与 AgentConfiguration，而非全仓机械分层。
2. 对每个 Module 写入口无关的行为测试；route 只 fake 它的稳定 interface。
3. 启用 import-boundary 检查并用小 allowlist 记录过渡例外和删除日期。
4. 每迁移一条垂直路径就删除旧 action/REST 重复编排，不增加兼容 service。

## 验收

- 删除一个 route 只删除 HTTP contract，不删除 DB 回写、cleanup、授权或事件语义。
- 同一 command 从 `/web`、`/api`、scheduler 进入时共享行为，仅 response contract 不同。
- 环检测和层级违规门禁为零或受时限例外控制。
- Module interface 的测试覆盖事务失败、并发、取消和补偿，不依赖 Elysia。

## 非目标

不是要求每层都增加一对一 wrapper。只有能隐藏显著复杂度、提高 leverage 的 Module 才值得存在；纯 CRUD 可直接使用受限 repository/query adapter。
