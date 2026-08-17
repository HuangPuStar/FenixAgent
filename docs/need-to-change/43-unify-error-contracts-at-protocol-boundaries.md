# 43. 未知错误只进统一边界，业务错误必须类型化

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 同一错误在不同入口状态/shape 漂移、内部 message 泄露、request 诊断上下文丢失 |

## 对抗判决

项目已有统一 error plugin，可映射、脱敏和记录 request context；多个 route 仍 catch 未知异常并自行构造 500，有的直接把原始 error.message 返回客户端。异常被 route 消费后，全局 handler 不再可见。同一 service 经 `/web` 与 `/api` 会得到不同 code/shape/日志。

## 已核验证据

- `src/plugins/error-handler.ts:17-98`：已有统一错误与脱敏边界。
- `src/routes/web/workflow-runs.ts:164-175`：局部 catch unknown 并返回 message。
- `src/routes/api/agents.ts:158-174`、`src/routes/api/skills.ts:42-57`：自行映射/返回未知异常。
- 前端 [25](./25-repair-frontend-request-seam.md) 又把这些不同响应混合成 Result/exception，形成端到端失败语义分裂。

## 架构诊断

Service error、protocol error 和 unexpected fault 是不同模型。当前 route 用字符串/instanceof 临时判断，把错误 classification implementation 复制到每个 adapter。全局 error Module 因调用方提前消费而失去 leverage。

## 目标不变量

- Application Module 只抛有限的 typed domain/application errors，包含安全 code、operation context 和 cause。
- Web/API/ACP 各有窄 error adapter，把同一 typed error 映射到各自稳定 contract。
- 未知异常不在 route catch；交统一边界记录完整 cause/requestId，客户端只得固定安全消息。
- 错误响应从 runtime schema 生成，状态码/code/retryability 一致；敏感字段永不序列化。
- cancellation、validation、conflict、not-found、dependency unavailable、timeout 与 internal fault 明确区分。

## 分阶段整改

1. 建立跨 `/web`、`/api` 的 error matrix contract test。
2. 从 Workflow/Agent/Skill 移除局部 unknown catch，保留只处理可恢复 typed error 的分支。
3. 前端 ApiError 映射 stable code，删除 raw message/toast 拼接。
4. 静态规则标记 route `catch` 中返回 500/raw message 的新增行为。

## 验收与观测

- 同一 application error 在不同协议保持语义等价、shape 合同稳定。
- canary secret/internal SQL/path 不出现在 response，server log 仍可凭 requestId 定位 cause。
- 指标按 error class/dependency/operation 统计，避免将用户取消算作系统故障。
