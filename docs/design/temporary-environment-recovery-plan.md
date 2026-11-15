# 临时环境持久回收与实例筛选实现计划

**目标：** Environment 整体回收待办跨重启保留；外部实例列表支持显式筛选。renew 失败保留已写期限。

**架构：** `environment.expiryReclaimedAt` 保存本轮到期回收确认；创建为空，renew 同次更新期限并置空。原到期 timer 继续即时停止；启动及每 10 分钟分批扫描已过期、未确认回收的环境。查询与确认更新归 Environment 仓储，取消与停止编排仍归现有生命周期协调器。沿用单活动控制面与节点恢复，不新增通用进程接管能力。

**规格：** 用户已确认本文件描述的 Environment 方案与列表筛选方案；长期契约同步至 `docs/arch/temporary-agent-environments.md`。

## 约束与审查重点

1. 所有本次改动未暂存，不提交；保持开始时已有 index 内容。
2. 同环境续期和回收串行，停止前重读期限，成功后只确认捕获的同一期限。
3. 任何停止未确认或确认写入失败均保留数据库待办；已确认历史不再进入扫描。
4. 批量扫描使用游标，单个持续失败的环境不能挡住后续环境；关闭后不得重新启动 timer。
5. 不以空内存 Runtime 状态当作节点终止证明；本地异常重启遗留仍为原有恢复边界。
6. 列表默认 regular，支持 temporary/all，SQL 过滤与 total、分页使用同一条件，保持原授权范围。

## 任务 1：外部实例筛选

文件：`src/schemas/api-instance.schema.ts`、`src/server/repositories/agent-instance.ts`、`src/server/services/api-instance.ts` 及列表测试，均位于 `packages/agent-runtime`。

- [x] 新增筛选、分页/count、隔离和非法参数回归，先运行失败。
- [x] 实现 `environmentType=regular|temporary|all`，响应不泄漏筛选字段。
- [x] 定向测试与限定文件 Biome 检查通过。

## 任务 2：Environment 持久回收

文件：owner `db/schema.ts`、Environment 仓储、temporary-environment lifecycle/state、Runtime 停止装配及相关测试。

- [x] 覆盖失败、确认写入失败、续期重置/竞态、重启补扫、成功退出调度、分页公平性；确认写入与停止证明先红后绿。
- [x] 新增 `expiryReclaimedAt`；仓储提供到期未确认分页查询与同一期限条件确认。
- [x] 生命周期成功后确认、续期清空标记；保留已有取消租约释放修复。
- [x] 启动与 10 分钟持久补扫复用同一回收入口，保留精确期限 timer。
- [x] 定向测试通过；生成并审查合并后的 0038，包含临时环境与回收确认结构，隔离 PostgreSQL 16 全链及重复迁移通过。

## 任务 3：文档与完整验证

- [x] 更新架构、外部 API 与接入文档，明确标记、重启补偿和筛选默认值。
- [x] 运行 `bun run fastcheck --no-tests`、`bun run precheck`；文档运行 `bun run docs:build`。
- [x] 新上下文审查本次完整未暂存 diff，处理实质问题。
- [x] 比对 index 快照，确认没有暂存或提交。

## 实施裁决

1. 不从数据库时间与控制面启动时间推导运行代次。新建事务提交后，仅为尚未执行运行操作且 Core 无记录的新实例向原协调器确认尚无 Runtime，避免跨时钟误判，也避免瞬时读取失败丢失来源证明；不另建环境来源集合。
2. 原系统没有持久化历史节点与 PID 归属。本轮保证持久待办不丢且未知状态不误报完成；历史来源丢失时保持待确认，不引入通用进程接管。
3. 单个任务失败由数据库每 10 分钟重试，删除原进程内 1 秒补偿队列，避免两套调度策略；到期即时 timer 保留。
