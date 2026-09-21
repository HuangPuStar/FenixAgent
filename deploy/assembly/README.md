# Assembly profiles

此目录保存随构建版本交付的静态模块组合。profile 只能选择已经编译进 `apps/generated/module-registry.ts` 的模块 ID，不能声明路径、URL、包名或代码入口。

`ce.json` 固定 CE 产品线选择的 access-control、Agent Runtime 和 Web Shell ID。registry 与 bootstrap 必须拒绝未知模块、类别不匹配及缺少工厂的基础模块。

## 字段与校验

| 字段 | 必填 | 校验 |
| --- | --- | --- |
| `identity` | 是 | 必须指向已注册的 `kind: "identity"` 模块 |
| `accessControl` | 是 | 必须指向已注册的 `kind: "access-control"` 模块 |
| `agentRuntime` | 是 | 必须指向已注册的 `kind: "agent-runtime"` 模块 |
| `webShell` | 是 | 必须指向已注册的 `kind: "web-shell"` 模块 |
| `resources` | 是 | 每项必须是已注册的资源模块 ID，按 `dependsOn` 拓扑排序 |
| `web` | 是 | 每项必须是已注册的 web contribution ID（即某模块 `fenix.module.ts` 里的 `web.id`，其 `web.contribution` 是入口说明符字符串）；只被浏览器 bundle 消费 |

`webShell` 只做校验与绑定，**不进入服务端的 `modules` / `instances`**：Shell 由 `apps/web` 自行消费，server 不实例化它。对应的 manifest 是 `apps/web/fenix.module.ts`（`kind: "web-shell"`，纯元数据，只允许 `import type`）。

`web` 与 `webShell` 不同：`web` 列表在**构建期**由 `bun run generate:web-contributions` 读取本目录的 JSON profile（**只支持 JSON**），生成 `apps/generated/web-contributions.ts`——它静态 import 各包 `web.contribution` 说明符，只被 `apps/web` 的构建消费。因此**部署期换 profile 不会重新打包浏览器 bundle**；YAML profile 属部署期覆盖入口，只影响服务端区段。

## 与生成 registry 的关系

profile 是「目标组合」，registry 是「已编译进镜像的模块清单」。二者必须同时满足：profile 选择了未注册的 ID 会在启动时抛错，而不是静默降级到某个默认实现。新增模块的流程是提供 package + manifest，再运行 `bun run generate:module-registry`（声明了 `web` 的模块还需 `bun run generate:web-contributions`），不需要改 app 的注册逻辑。

profile 可随镜像交付，也可作为受部署平台保护的只读挂载文件在启动时读取；其位置由发布脚本固定，不能由 profile 自己指定。
