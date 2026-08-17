# 34. 把架构原则变成可执行的 Fitness Functions

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 规则只能靠评审记忆，回归在规模增长后才显现，测试产生虚假信心 |

## 对抗判决

项目有明确的 500 行、分层、API、i18n、请求、租户和测试规则，但没有对应门禁：81 个审计范围文件超过 500 行；层级和包环真实存在；前端测试中有读取源码断言方法名的用例，正好漏掉 runtime 假成功；`precheck` 还会自动 `--write`，并只跑 `src/__tests__`，与 CI 语义不同。

## 已核验证据

- `scripts/ci.ts:10-55`：precheck 包含会写文件的 format/import sort，并只执行 backend test 目录。
- `.github/workflows/ci.yml:27-61`：CI 为 non-mutating format check，并额外跑 packages/frontend；本地“precheck 全绿”与 CI 不是同一证据。
- `web/src/__tests__/trigger-panel.test.tsx:7-99`：读取源码并断言方法名，未执行 mutation/错误语义。
- 扫描发现 5 route→db、11 route→repository、27 service→db、3 repository→service，及 7 个相对 import 环。
- 设计文档多次要求 `bun run check:deps`，`package.json` 不存在该命令。

## 目标 Fitness Functions

建立少而硬、直接对应不变量的机器规则：

- dependency graph：层级方向、package SCC、public export、manifest dependency 诚实性。
- module size：生产文件 500 行硬门禁；现存超限使用基线白名单且只减不增，例外含 owner/移除条件。
- API contract：runtime schema/handler/client/OpenAPI consumer tests，禁止 handler 读 schema 外字段。
- tenant/security：repository scoped key、跨组织矩阵、出网/HTML/secret logging 静态与动态测试。
- frontend：真实 mutation failure、async race、keyboard、i18n key、route bundle/request budget。
- runtime：fan-out relay、RPC correlation、Y.Doc cold restore/backpressure、cancel/drain 和 resource leak tests。
- release：clean checkout build、migration/e2e/image smoke 与 immutable digest。

## 工具与流程原则

- `precheck` 拆为只读 `verify` 和显式 `fix`；CI、本地提交门禁调用同一个 verify graph。
- 不以覆盖率数字替代关键故障链；对并发/故障使用 deterministic fake clock/transport/storage。
- Fitness Function 失败必须指向规则、owner、例外文件和修复文档，避免变成不可行动噪音。
- 新门禁先生成 baseline，阻断新增；按整改波次逐步清零旧债，禁止永久 broad ignore。

## 验收

- 故意引入 route→db、包环、幻影字段、未 unwrap mutation、硬编码字符串或 bundle 超限，PR 明确失败。
- 本地 verify 与 CI 使用相同命令和输入，且不修改工作区。
- 关键测试验证行为/状态，不读取实现源码字符串证明“存在某方法”。
- 每条 CLAUDE/开发规范红线都有对应自动检查，或明确记录为什么只能人工审查。

## 非目标

规则数量不是目标。只保留能保护领域边界、并发/失败语义和用户流程的高 leverage 检查；格式类工具不应掩盖架构证据。
