# 编排域独立包重构 — 路线图

> 父级 PRD：[2026-08-03-orchestration-package-prd.md](../2026-08-03-orchestration-package-prd.md)
> ADR：[spec/global/adr/2026-08-03-orchestration-package-design.md](../../../spec/global/adr/2026-08-03-orchestration-package-design.md)
> 标签：`ready-for-agent`

## Issue 顺序

| # | Issue | 依赖 | 可验证 |
|---|-------|------|--------|
| I1 | [01-package-foundation.md](01-package-foundation.md) | 无 | 包可被 import，所有类型和错误可用 |
| I2 | [02-agent-node-lifecycle.md](02-agent-node-lifecycle.md) | I1 | AgentNode 创建→状态转移→回收，全 mock |
| I3 | [03-agent-controller-spawn.md](03-agent-controller-spawn.md) | I2 | spawnInstance → Instance.status()/send()，全 mock |
| I4 | [04-integration-and-cleanup.md](04-integration-and-cleanup.md) | I3 | `bun test` + `bun run precheck` 全绿，旧代码删除 |

## 实施规则

- 按顺序实现，不可跳过
- 每个 Issue 完成后运行 `bun test` 验证，再进入下一个
- 全部完成后运行 `bun run precheck`
