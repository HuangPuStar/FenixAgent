# 临时环境 E2E

在仓库根目录运行，需要 Bun 和已安装的项目依赖。

```bash
FENIX_USER_API_KEY='你的用户 API Key' \
FENIX_AGENT_ID='要测试的 Agent UUID' \
bun run scripts/temporary-environments/e2e.ts
```

服务地址默认 `http://127.0.0.1:3000`。远程服务增加 `FENIX_BASE_URL='https://你的服务地址'`，也接受以 `/api/v1` 结尾的地址。
这两个必填值也可以放进本地 `.env`，然后直接执行脚本；不要提交凭据。

## 前提与影响

1. API Key 对指定 Agent 具有 use/update 权限，Agent 的模型和执行节点可用。
2. 使用测试 Agent：脚本会临时调整它的 TTL 策略，影响运行期间其他调用方新建、续期的环境。结束、失败或 Ctrl+C 后尝试恢复原策略；若检测到其他调用方又修改策略，则保留其修改并报清理失败。强制杀进程无法执行恢复，原策略会打印在开头。
3. 需要两个可用运行槽位。创建 A、B 后并发启动：A 使用 ACP，B 使用 OpenAI 兼容接口；每轮同时发送，两轮共四次模型回复。测试结束停止本次实例，环境记录和测试文件按临时环境设计保留，不删除其他资源。
4. 准备阶段 TTL 保留原有效期限，并至少覆盖启动与两轮请求的预算，最终受部署上限限制；到期测试阶段才改为短 TTL。首次启动或模型响应很慢时可增加请求超时，部署 TTL 上限也需覆盖该预算。
5. Ctrl+C 不会中断已发出的策略写入，脚本在请求超时预算内等待同步成功或明确拒绝的响应，再恢复原策略。断网、超时、服务端或网关错误及其他未约定响应会保留“结果未确认”并报清理失败，不用旧值查询假定恢复成功；需待服务端写入结束后人工核对原策略。

## 自动验证范围

1. 创建返回独立身份和有效期限，创建后 Runtime 尚未启动。
2. 默认、regular 列表排除临时实例；temporary、all 可找回新实例；分页、total 和非法参数校验。
3. A、B 并发 connect。A 通过返回的 ACP relay 创建一次 session，两轮 `session/prompt` 复用同一 session；B 第一轮使用 `X-Instance-Id`，第二轮另带第一轮的 `X-Session-Id`。
4. 每轮 ACP 与 OpenAI 请求并发，完成本轮后再进入下一轮。A、B 第一轮分别记住随机校验码，第二轮不重发校验码或完整历史，验证各自记忆保留、上下文不串线。控制台同时打印 ACP 收发帧与 HTTP 请求响应；Key 和会话句柄脱敏。
5. A、B 同名文件隔离，停止和续期后原文件内容保留。停止接口返回 `202` 仅表示受理，脚本持续查询实例，确认 `stopped` 后再继续；`unknown` 或超时判失败。
6. 短 TTL 到期后 Runtime 自动停止，connect 和聊天返回 `410 / ENVIRONMENT_EXPIRED`。
7. 过期记录仍可找回，显式续期恢复原 Environment、Instance 和文件。

每次请求打印方法、URL、脱敏请求头、请求体、HTTP 状态、耗时与响应。单条日志超过 20000 字符时显示截断标记，断言仍使用完整数据。
每步输出 `[PASS]` 或 `[FAIL]`，末尾输出 `[SUMMARY]`；失败退出码 1，Ctrl+C 退出码 130。

纯 API Key 无法执行服务重启、停止失败注入或读取数据库确认字段。这些不算自动验证通过，脚本末尾以 `[MANUAL]` 明确列出。

## 可选配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `FENIX_BASE_URL` | `http://127.0.0.1:3000` | 服务地址 |
| `TEMP_ENV_E2E_TIMEOUT_MS` | `120000` | 每个 HTTP 请求的超时，毫秒 |
| `TEMP_ENV_E2E_EXPIRY_SECONDS` | `5` | 到期阶段 TTL，秒 |
| `TEMP_ENV_E2E_STOP_GRACE_MS` | `60000` | 显式停止及到期后等待 Runtime 停止的宽限时间，毫秒 |

```bash
bun run scripts/temporary-environments/e2e.ts --help
```
