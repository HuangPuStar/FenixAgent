# core-runtime 集成测试

这个目录放 `@mothership/core` 的真实链路集成测试，用来验证：

- `createCoreRuntime()`
- `registerPlugin`
- `registerNode`
- `launchInstance`
- `connectInstanceRelay`
- ACP `connect -> new_session -> prompt`
- 收到目标 relay 响应
- `stopInstance`

## 配置方式

仓库内的 [core-runtime.conf.json](./core-runtime.conf.json) 是可提交模板，不要直接把真实密钥写进去。

本地运行时请新建：

```text
./core-runtime.local.json
```

可以直接复制模板后再修改：

```bash
cp ./core-runtime.conf.json ./core-runtime.local.json
```

然后至少填写这些字段：

- `"enabled": true`
- `launchSpec.workspace`
- `launchSpec.model`
- `relay.requestMessages[0].payload.cwd`

本地私有配置文件已被 [`.gitignore`](./.gitignore) 忽略，不会提交。

## 运行命令

```bash
bun test ./core-runtime.integration.test.ts
```

## 成功判定

当前默认配置会在收到这类消息时判定通过：

```json
{
  "type": "session_update",
  "sessionUpdate": "agent_message_chunk"
}
```

## 排错提示

测试会输出阶段日志，常见格式如下：

- `registerPlugin:start/ok/error`
- `registerNode:start/ok/error`
- `launchInstance:start/ok/error`
- `connectRelay:start/ok/error`
- `waitForExpectedResponse:start/ok/error`

如果最后超时，日志里还会打印：

- 本次 `successMatch`
- 最后一条收到的 relay 消息 `lastMessage`

这样可以快速判断是卡在 facade 装配、启动、建 session，还是只是成功匹配条件写错了。
