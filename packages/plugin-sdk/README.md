# plugin-sdk

`@mothership/plugin-sdk` 提供 engine plugin 对接宿主时会共享的一组 TypeScript 类型定义。

当前主入口会统一导出三类公共类型：

- 启动配置类型：`AgentLaunchSpec` 及其关联的 `AgentConfig`、`ModelConfig`、`SkillConfig`、`McpServerConfig`
- 插件生命周期类型：`EnginePlugin`、`EngineRuntime`、`EnginePluginMeta` 以及各阶段输入类型
- relay 类型：`EngineRelayHandle`、`EngineRelayMessage`、`EngineSessionSummary`、`EngineHealthStatus`

## 使用方式

一个第三方 engine 包通常至少需要：

```text
your-engine-package/
├── package.json
└── src/
    ├── index.ts
    └── plugin.ts
```

1. `plugin.ts` 实现 `createEnginePlugin()`
2. `index.ts` 导出 `createEnginePlugin()`

`createEnginePlugin()` 需要返回一个 `EnginePlugin`，其中：

- `meta` 声明插件 id、展示名、版本
- `createRuntime()` 返回 `EngineRuntime`

`EngineRuntime` 最少实现四段式生命周期：

- `prepareEnvironment({ instanceId, launchSpec })`
- `startInstance({ instanceId })`
- `connectRelay({ instanceId, sessionId })`
- `stopInstance({ instanceId })`

`prepareEnvironment()` 是唯一接收 `AgentLaunchSpec` 的阶段。插件应在这里完成配置写入、目录准备或环境预热等前置工作。

## 导入示例

```ts
import type {
  AgentLaunchSpec,
  EnginePlugin,
  EngineRelayHandle,
  EngineRuntime,
  McpServerConfig,
} from "@mothership/plugin-sdk";
```

## 最小实现

```ts
import type { EnginePlugin, EngineRelayHandle } from "@mothership/plugin-sdk";

export function createEnginePlugin(): EnginePlugin {
  return {
    meta: {
      id: "demo",
      displayName: "Demo Engine",
      version: "0.1.0",
    },
    createRuntime() {
      return {
        async prepareEnvironment({ instanceId, launchSpec }) {
          console.log("prepare", instanceId, launchSpec.workspace);
        },
        async startInstance({ instanceId }) {
          console.log("start", instanceId);
        },
        async stopInstance({ instanceId }) {
          console.log("stop", instanceId);
        },
        async connectRelay(): Promise<EngineRelayHandle> {
          return {
            state: "open",
            send() {},
            close() {},
          };
        },
      };
    },
  };
}
```

## 参考实现

- 如需参考真实实现，请直接看 `packages/plugin-opencode`
- 入口在 `packages/plugin-opencode/src/plugin.ts`
- relay 适配在 `packages/plugin-opencode/src/relay/`
- 运行时配置写入在 `packages/plugin-opencode/src/runtime/`
