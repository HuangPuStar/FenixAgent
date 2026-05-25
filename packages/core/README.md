# @mothership/core

`@mothership/core` 是本仓库的本地 node 编排内核，负责把上层准备好的
`engineType + nodeId + AgentLaunchSpec` 组装成统一的实例生命周期：

- 注册 engine plugin
- 注册可调度 node
- 编排 `prepare -> start -> connectRelay -> stop`
- 暴露统一的实例状态快照与错误模型

它的定位是“编排层”，不负责组装业务侧 `AgentLaunchSpec`，也不依赖具体插件的私有实现细节。

## 使用方式

包外唯一推荐入口是 `createCoreRuntime()`：

```ts
import { createCoreRuntime } from "@mothership/core";
import { createEnginePlugin } from "@mothership/opencode";

const core = createCoreRuntime();

core.registerPlugin(createEnginePlugin());
core.registerNode({
  id: "local-default",
  mode: "local",
  engineTypes: ["opencode"],
  status: "online",
});
```

上层通常只需要做两件事：

1. 在启动阶段注册 plugin 和 node
2. 在业务请求进来时调用实例生命周期方法

## 生命周期示例

下面是 `src` 层最常见的一条调用链：

```ts
import type { LaunchInstanceRequest } from "@mothership/core";

const launchRequest: LaunchInstanceRequest = {
  instanceId: "inst_demo_001",
  engineType: "opencode",
  nodeId: "local-default",
  launchSpec: {
    workspace: "/path/to/workspace",
    env: {},
    agent: {
      name: "general",
      prompt: "You are a helpful assistant.",
    },
    model: {
      provider: "openai",
      id: "gpt-5",
    },
    skills: [],
    mcpServers: [],
  },
};

const instance = await core.launchInstance(launchRequest);
const relay = await core.connectInstanceRelay({ instanceId: instance.instanceId });

await relay.send({ type: "connect" });

await core.stopInstance(instance.instanceId);
```

对应的状态推进由 `core` 内部统一维护：

- `created`
- `preparing`
- `prepared`
- `starting`
- `running`
- `stopping`
- `stopped`
- `error`

如果中间任一步失败，实例快照会进入 `error`，并写入 `errorMessage`。

## 对外 API

`createCoreRuntime()` 返回的 facade 会暴露这些稳定方法：

- `registerPlugin(plugin)`
- `registerNode(node)`
- `launchInstance(request)`
- `connectInstanceRelay({ instanceId, sessionId? })`
- `stopInstance(instanceId)`
- `getInstance(instanceId)`
- `listInstances()`
- `getNode(nodeId)`
- `listNodes()`
- `getPlugin(engineType)`
- `listPlugins()`

如果 `src` 层只想依赖稳定边界，应该只使用这些 facade 方法，不直接碰内部 store 或 orchestrator。

## 实例状态查询

`getInstance()` 和 `listInstances()` 返回的是编排层快照，不是插件 runtime 内部状态对象。

当前快照字段包括：

- `instanceId`
- `engineType`
- `nodeId`
- `status`
- `launchSpec`
- `relayConnected`
- `errorMessage`
- `createdAt`
- `updatedAt`

这份快照的意义是让上层知道：

- 当前实例是否已经进入 `running`
- relay 是否已经接通
- 最近一次失败发生在哪条链路上

## 错误模型

`@mothership/core` 使用 `CoreRuntimeError` 表达稳定错误码。上层可以优先判断 `code`，而不是依赖字符串匹配。

常见错误码包括：

- `DUPLICATE_ENGINE_PLUGIN`
- `PLUGIN_NOT_FOUND`
- `DUPLICATE_CORE_NODE`
- `NODE_NOT_FOUND`
- `NODE_OFFLINE`
- `ENGINE_NOT_SUPPORTED`
- `INSTANCE_ALREADY_EXISTS`
- `INSTANCE_NOT_FOUND`
- `INVALID_INSTANCE_STATE`

示例：

```ts
import { isCoreRuntimeError } from "@mothership/core";

try {
  await core.connectInstanceRelay({ instanceId: "inst_demo_001" });
} catch (error) {
  if (isCoreRuntimeError(error) && error.code === "INVALID_INSTANCE_STATE") {
    console.error("实例尚未进入 running，暂时不能连接 relay");
  }
}
```

## 接入约束

- `createCoreRuntime()` 是包外唯一推荐入口
- `src/index.ts` 只导出 facade、registry、核心类型和测试友好工厂
- `core` 只依赖 `@mothership/plugin-sdk` 的公共接口，不读取具体 plugin 的私有状态
- `connectInstanceRelay()` 仅允许在实例 `running` 时调用
- `stopInstance()` 对已经 `stopped` 的实例保持幂等

## 推荐接入方式

如果后面要把它接进 `src` 层，建议按下面的职责分工来：

- `src` 负责组装 `LaunchInstanceRequest`
- `src` 负责决定选哪个 `engineType`、`nodeId`
- `core` 负责检查 plugin/node 是否可用
- `core` 负责驱动实例生命周期
- `plugin` 负责真正的 runtime、进程和 relay 细节

这样后续扩展 remote node 或替换 engine plugin 时，`src` 层只需要继续依赖同一套 facade。

## 目录职责

- `src/facade/`: `createCoreRuntime()` 对外装配入口
- `src/registry/`: plugin 与 node 注册表
- `src/runtime/`: 实例状态存储与生命周期编排
- `src/types/`: core 对外稳定类型
- `src/errors/`: 统一错误模型
- `src/__tests__/`: registry、store、orchestrator、facade 单元测试
- `integration/`: 默认关闭的真实链路手动验证入口

## 手动联调

真实插件链路验证入口位于：

- `packages/core/integration/README.md`
- `packages/core/integration/core-runtime.integration.test.ts`

默认模板配置是关闭的：

```json
{
  "enabled": false
}
```

需要手动联调时：

1. 复制 `core-runtime.conf.json` 为 `core-runtime.local.json`
2. 填入真实 `workspace`、模型参数和密钥
3. 在 `packages/core/integration` 下运行：

```bash
bun test ./core-runtime.integration.test.ts
```
