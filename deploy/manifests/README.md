# Manifest 部署事实

本目录承载 `@fenix/platform-sdk` 模块描述符（`fenix.module.ts`）在**部署侧**的事实，供 profile 校验与
部署前自检（preflight）使用：不启动应用就能回答「这个版本里有哪些模块、各自属于什么类别、要哪些依赖服务、
探针打哪里」。

```text
deploy/manifests/
├── modules.json             # 生成：全部已注册模块的事实索引
├── profiles/<profile>.json  # 生成：按装配 profile 展开的部署视图
└── README.md                # 本文件（手写）
```

## 生成关系

两个 JSON 都是生成物，带 `generatedBy` / `note` 标记，**请勿手改**：

```bash
bun run release            # 生成
bun run release --check    # 校验漂移（CI 口径）
bun run release --deploy   # 执行发布：第 0 步校验 → DDL 迁移 → 数据迁移 → 容器部署（失败即停）
```

该入口默认**只做生成与校验**（含漂移判定），不执行迁移也不启停容器；只有显式给出 `--deploy` 才改动运行环境，
且每一步仍调用既有权威入口（迁移两步走 `scripts/migrate.ts` 与 `db/data-migration-runner.ts`，容器部署的命令
取自下面 `compose.up`）。发布顺序与失败判定见 `docs/operations/upgrade.md` §1。

本目录的两个 JSON 由生成器**独占**：`biome.json` 的 `files.includes` 排除了 `deploy/manifests/`（与
`!!**/drizzle` 同一口径）。原因是漂移判定按**字节**进行——格式化器会把数组折成一行，而生成器输出的是
`JSON.stringify(..., null, 2)`，一格式一比对就会互相当成漂移。要改产物格式就改生成器与它的用例，不要靠格式化。

真相来源是各模块的 `fenix.module.ts`（`id` / `kind` / `capabilities` / `dependsOn` / `dependencyServices`）；
生成器用 AST 静态读取字面量，不执行 manifest。判定与 `apps/server` 的 `createModuleRegistry` 同一套：
ID 已注册、`kind` 匹配槽位、`dependsOn` 闭包、capability 唯一、探针锚定本模块声明过的环境变量键。

## `modules.json`

已注册模块的索引（不按 profile 过滤——它对应「已编译进镜像的模块」，与 `apps/generated/module-registry.ts`
同一集合）：

| 字段 | 含义 |
| --- | --- |
| `id` / `kind` | 模块 ID 与类别；`kind` 取 `access-control` / `agent-runtime` / `identity` / `resource` / `web-shell`（§2.3） |
| `capabilities` | 模块对外声明的能力标识；同一 capability 不得由两个已启用模块提供 |
| `dependsOn` | 装配依赖：启用本模块时必须同时启用哪些模块 |
| `manifest` / `package` | 声明所在文件与包名，便于回溯 |
| `dependencyServices` | 依赖服务与探针；`orchestration` 指明编排归属（`compose-overlay` = `deploy/compose/overlays/` 定义，`separate` = 自有编排入口 `composeFile`） |

## `profiles/<profile>.json`

按 `deploy/assembly/<profile>.json` 展开的**部署视图**，与 `modules.json` 同批生成：

| 字段 | 含义 |
| --- | --- |
| `profile` / `profileFile` | 装配 profile 的 ID 与来源文件 |
| `enabledModules` | 该 profile 启用的模块（与 `ModuleRegistry.resolveProfile` 的 `modules` 同序，Web Shell 不在其中） |
| `dependencyServices` | 合并后的依赖服务：`declaredBy` 记录谁依赖它，`required` 取并集（只要有模块断言必需，自检就必须阻断），`healthCheck` 是探针 |
| `compose.files` / `compose.up` | 该 profile 对应的编排文件与启动命令（基础编排 + 本 profile 命中的模块 overlay） |

## 与其它产物的关系

| 产物 | 关系 |
| --- | --- |
| `deploy/assembly/<profile>.json` | 输入：选择模块组合的 profile，由部署方维护 |
| `apps/generated/module-registry.ts` | 服务端装配用的静态 import 清单；本目录是不执行代码的部署侧视图 |
| `deploy/compose/` | 编排归属：`base.yml` 手写，`overlays/` 与本目录同批生成 |
| `deploy/env/rcs.example` | 环境变量清单；`dependencyServices.envKeys` / `healthCheck.addressKey` 都指向它列出的键 |
