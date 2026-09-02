# 32. Readiness、SLO 与日志隐私必须成为生产接口

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0（日志内容）/ P1（readiness 与性能） |
| 置信度 | 高 |
| 影响 | 用户正文持久化、事件循环阻塞、失能副本接流量、故障无法定位 |

## 对抗判决

`/health` 永远返回 ok，不检查 DB、Redis、runtime/relay 或 schema；Docker 以它判健康。另一方面主入口拦截 console 并写入 pino，acp-link/Hermes 正常路径记录 prompt、result、session load 和协议对象，logger 没有 redact，且每条日志同步 `appendFileSync`。系统既暴露内容，又缺少可靠的服务状态信号。

## 已核验证据

- `src/services/build-info.ts:38-44` 与 `src/index.ts:186-187`：health 只返回进程信息和固定 ok。
- `Dockerfile:94-95`、`docker-compose.yml` 的 `rcs` 服务：健康检查只访问该端点。
- `src/index.ts:1-4` 与 `packages/logger/src/index.ts:334-353`：全局 console 进入 logger。
- `packages/logger/src/index.ts:151-160`：每条日志同步 appendFile；无 redact/censor 配置。
- `packages/acp-link/src/server.ts:1170,1246-1257,1450`：完整/截断 prompt、result、未知消息进入日志。
- `packages/acp-link/src/client/protocol.ts:66,102`：raw/parsed 协议内容；`src/services/hermes-client.ts:217-222`：聊天文本。
- `packages/logger/src/index.ts:119-158`：retention 每个 stream 生命周期只清理一次。

## 架构诊断

日志 API 接受任意 string/object，没有事件 schema；业务调用者决定哪些敏感 implementation 可落盘。health 又把 process alive 与 service ready 混为一个 boolean。可观测 interface 无法表达依赖降级、队列积压、状态恢复和数据安全。

## 目标方向

- 区分 liveness（进程未死）与 readiness（可安全接新工作）；readiness 有短 timeout 地检查 DB、schema、必要 Redis/relay 能力，非必要依赖以 degraded reason 表达。
- 定义结构化日志事件 allowlist：ID、状态、长度、耗时、错误分类；prompt/message/token/path/query 默认不记录，必要时 hash/长度化。
- logger 配置强制 redact secret/token/cookie/authorization/connection string 和已知字段；未知对象不自动 JSON 全量序列化。
- 使用异步 stdout/collector/sidecar 或有界异步 sink，不在 Bun request loop 同步落盘；磁盘失败不阻塞核心请求也不能无声吞掉。
- 建立 SLO：HTTP/WS/Agent turn 成功率与时延、relay reconnect、Y.Doc recover/persist、Workflow stuck/finalizer、DB/Redis pool、队列/资源上限。

## 分阶段整改

1. 立即移除正文/协议对象日志并配置全局 redaction；轮换/删除已泄露日志按数据治理流程处理。
2. 增加 `/live`、`/ready` 和 schema version check，部署只把 ready 副本接流量。
3. 迁移到结构化事件和异步 sink，设置丢弃/背压策略与磁盘告警。
4. 从 ADR 中提取关键 SLO/恢复信号，建立 dashboard 与发布 smoke。

## 验收

- canary prompt/token/DB URL 不出现在 stdout、普通/error 文件或 tracing attributes。
- DB/必要 Redis/schema 不可用时 live 可保持、ready 失败；恢复后自动 ready。
- 日志洪峰不显著阻塞 event loop；sink 满时按策略计数/告警。
- 指标/日志可从 requestId/runId/channelId 定位故障，但不记录用户正文。

## 回滚

readiness 初期可只告警观察，再切流量门禁；日志脱敏不回滚。诊断需要正文时使用受审批、短时、采样且独立加密的 break-glass 流程。
