# 30. Workspace manifest 必须诚实，composition root 不能位于协议包

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高；manifest 与源码 import 已交叉核验 |
| 影响 | 单包无法安装/发布、循环初始化、hoist 掩盖缺依赖、边界不可测试 |

## 对抗判决

`acp-link` 在 runtime import ccb/claude-code/opencode/plugin-sdk，却把它们全部放在 devDependencies；opencode/ccb 又依赖 acp-link，形成真实双向包环；claude-code 源码 import acp-link，但 manifest 完全未声明。根 tsconfig paths 和 Bun workspace hoist 使 monorepo 内看似可用，却无法证明包独立安装/构建。

## 已核验证据

- `packages/acp-link/src/server.ts:6-10`：runtime import 三个 engine plugin 与 SDK。
- `packages/acp-link/package.json:49-58`：上述依赖都列 devDependencies。
- `packages/plugin-opencode/package.json:12-16`、`packages/plugin-ccb/package.json:12-16`：反向依赖 acp-link。
- `packages/plugin-claude-code/src/claude-code-handler.ts:9-11` import acp-link，而其 `package.json:12-18` 未声明。
- `tsconfig.base.json:3-13` 使用源码 path alias；`web/vite.config.ts:18-24` 更直接 alias `chat-channel/src/index.ts`，绕过包 export/build 边界。
- 当前相对 import 扫描还发现 7 个源码环；包级环只是更高层表现。

## 架构诊断

acp-link 同时是协议 core、stdio/WS transport、进程管理和 engine composition root。插件 adapter 反向依赖宿主实现，宿主又静态 import 全部插件。这样任何新增引擎都会修改核心包并扩大循环，Module interface 没有 leverage。

## 目标方向

- 抽取不依赖具体 engine 的 ACP protocol/transport core；只定义消息、dispatcher port 和 runtime port。
- composition root 留在应用装配层，通过 registry/factory 注入 engine handler；core 不 import plugin。
- 每个 package manifest 精确声明 runtime、peer、dev dependency；不依靠 root/hoist 提供幽灵依赖。
- web 通过 package public export/构建产物消费 chat-channel，不指向内部源码路径。
- 包边界和 [2](./2-introduce-instance-relay-broker.md) 对齐：transport core 不拥有业务 session/instance 策略。

## 分阶段整改

1. 生成 package dependency graph 和 SCC，CI 先报告后阻断新增环。
2. 抽最小 protocol types/transport core，迁移 plugin handler 的类型依赖。
3. 将 plugin imports 移到 root registry，拆除 acp-link ↔ plugin 环。
4. 每包独立 pack/install/typecheck/build/test，删除 tsconfig 源码 alias 例外。

## 验收

- 图中无 package SCC；每包在空临时目录只用自身 manifest 可安装/构建。
- `dependencies` 缺失、未使用依赖、深路径 import 和源码 alias 在 CI 失败。
- 删除任一 plugin 不影响 core package 构建，root 只少注册一种能力。

## 文档漂移

项目地图声称 11 个内部包，实际 `packages/*/package.json` 为 14 个。完成整改时同步 [35](./35-make-architecture-docs-versioned-truth.md)。
