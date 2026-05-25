# @mothership/opencode

`@mothership/opencode` 是仓库里的首个真实 engine plugin，负责把平台层的
`AgentLaunchSpec` 转成 opencode 运行时可消费的 workspace、进程和 relay 生命周期。

## 使用方式

包外唯一应该调用的入口是 `createEnginePlugin()`：

```ts
import { createEnginePlugin } from "@mothership/opencode";

const runtime = createEnginePlugin().createRuntime();
```

## 目录职责

- `src/plugin.ts`: 插件入口工厂，声明固定 `meta` 并组装 `createRuntime()`
- `src/runtime/`: runtime 生命周期与共享实例状态表
- `src/process/`: 本地 `acp-link` 进程与端口分配逻辑
  - `port-allocator.ts` 统一维护 `8888-8999` 端口分配与释放
  - `acp-link-process-manager.ts` 负责 `acp-link` 子进程启停和本地 WS token 捕获
- `src/relay/`: 连接本地 `acp-link` WebSocket 的共享 relay 句柄
- `src/__tests__/`: 插件入口、prepare、process、relay 和 runtime 主流程测试

## 设计约束

- `src/index.ts` 只暴露公开入口，不泄漏内部 process/relay 实现细节
- `createEnginePlugin()` 是唯一外部调用入口
- 本地 WS token 来自 `acp-link` stdout 捕获，只用于连接本地 relay，不能与 RCS
  environment secret 混用
- runtime 内部状态会在 `prepareEnvironment`、`startInstance`、`connectRelay`、
  `stopInstance` 四段生命周期之间共享，后续模块都基于同一状态表协作
