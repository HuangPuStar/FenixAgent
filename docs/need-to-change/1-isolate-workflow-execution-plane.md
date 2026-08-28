# 1. 把租户 Workflow 执行从控制面进程隔离出去

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 / 上线停止线 |
| 置信度 | 高，执行链已静态闭合 |
| 影响 | 宿主命令执行、环境密钥外送、控制面文件/网络访问、拒绝服务 |
| 主要 Module | Workflow Definition、Workflow Engine、Execution Plane |

## 对抗判决

普通已登录成员可以保存、发布并运行包含 Shell/Python 节点的 Workflow；执行器直接在 RCS 控制面容器中启动 `/bin/sh` 或 `python3`，默认工作目录是 `process.cwd()`，环境从完整 `process.env` 开始构造。这不是“脚本功能权限偏宽”，而是租户数据平面与平台控制面没有物理安全边界。

## 已核验证据

- `src/routes/web/workflow-defs.ts:194-249`：保存和发布只要求 `sessionAuth`，没有 owner/admin 或受信执行角色检查。
- `src/routes/web/workflow-runs.ts:97-180`：任意 session 用户可提交 YAML 或 workflowId 运行。
- `packages/workflow-engine/src/executor/process-executor.ts:39-44,69-73,160-165`：字符串走 `/bin/sh -c`，继承全量进程环境和宿主 cwd。
- `packages/workflow-engine/src/executor/python-executor.ts:39-61,136-149`：任意 Python 写入临时文件执行，继承全量环境；还可安装 requirements。
- `Dockerfile:35-97`：控制面镜像同时拥有 git、curl、Python、包管理器、Agent CLI 和生产数据卷，放大执行权限。

最小反例：成员创建 Shell 节点读取 `DATABASE_URL`、`RCS_SYSTEM_API_KEYS` 或容器挂载目录，再通过 API 节点/普通网络连接外送。即使 UI 不暴露某字段，直接调用 `/web/workflow-runs` 仍可到达执行器。

## 架构诊断

Workflow Engine 作为 Module 暴露了“执行 DAG”的简洁 interface，却把最危险的 implementation——进程、文件系统、网络和密钥——放在控制面信任域内。这个 Module 表面很深，安全边界却是浅的：一个 YAML 字段直接穿透到宿主能力。删除测试也失败：若删除 ProcessExecutor，调用方会立刻失去隐含的宿主 env/cwd 约定，说明这些复杂度没有被执行面封装。

## 目标方向

建立独立 Execution Plane，并把每次运行视为不可变的受限 Job：

- 控制面只提交经过校验的执行描述、租户身份、资源预算和显式 secret 引用，不传完整宿主环境。
- Job 在短生命周期 sandbox/remote runner 中运行，默认无宿主文件、无控制面网络、无特权用户。
- Shell/Python、API、Agent 节点按信任等级分别授权；普通成员不能通过低权限入口获得高权限 runner。
- 出网统一进入 [4](./4-centralize-outbound-request-policy.md)，workspace 统一使用 [3](./3-enforce-tenant-execution-binding.md)。
- 运行输出、artifact、审计事件和终态通过窄 interface 返回，runner 崩溃不能拖垮 HTTP/Chat 控制面。

这里先固定边界与不变量，不提前锁定具体容器、Kubernetes Job 或 sandbox provider；技术选择应由隔离实验决定。

## 分阶段整改

1. 立即：feature flag 关闭普通成员 Shell/Python；执行前拒绝未显式授权的节点类型。
2. 最小垂直切片：把一个 Shell 节点迁到隔离 runner，证明 env allowlist、只读输入、资源上限、取消和 artifact 回传。
3. 扩展：迁移 Python 依赖安装、网络策略、secret broker 和并发配额。
4. 删除：移除控制面内 `Bun.spawn` 路径及其宿主 cwd/env 兼容行为。

## 验收与观测

- 对抗测试读取控制面 env、`/app/data`、Docker socket、metadata IP 均失败。
- CPU、内存、进程数、磁盘、stdout/stderr 和运行时长都有硬上限；取消后进程树被回收。
- 日志只记录 job/run/node ID、策略命中和资源用量，不记录 secret、命令展开后的敏感值或完整输出。
- 指标至少包含排队时长、启动时长、超时/强杀、策略拒绝、sandbox 泄漏检测和孤儿 Job 数。
- 回滚只允许将执行流量切回“禁用/只读节点”，不允许回到控制面宿主执行。

## 非目标与误报排除

- 这不是要求移除 Workflow；目标是把执行能力放到正确的信任域。
- `timeout` 和 stderr 大小限制只能约束部分资源，不能替代进程、文件、网络和密钥隔离。
- 多租户 DB 过滤不能缓解宿主代码执行；两者是独立边界。
