# 模块、公开面与静态装配

> 本文是目录、模块交付、公开 exports、依赖分类、registry/bootstrap 与 env/secret 的 canonical detail。ARC-02 冻结 platform/app 与静态装配机制；Agent/resource 的具体 package、module 和 capability 仅作为 ARC-03 输入草案。具体 identity 只见[根索引](../ce-ee-engineering-architecture.md#4-identity-summary)。

## 1. 仓库与目录责任

CE 与 EE 使用相同逻辑骨架；EE 的 `upstream/fenix` 是固定 revision 的 submodule，不是共享开发目录，EE 不在其中提交补丁。

```text
fenix/ or fenix-ee/
├── apps/
│   ├── server/                 # HTTP/WS、server registry、装配与进程生命周期
│   └── web/                    # Web registry、TanStack Router、最终 Shell
├── packages/
│   ├── platform/               # 中性契约、AccessControl、observability
│   ├── agent/                  # runtime、instance、chat、engine SDK/providers
│   └── resources/              # 完整资源领域及其 route/db/web contribution
├── db/                         # 本仓库 DDL 链与 data migration runner
├── deploy/                     # assembly、images、compose、env、平台 manifests
├── scripts/                    # 校验、构建、迁移、发布的薄入口
├── docs/                       # arch、design、developer、operations、ADR
└── upstream/fenix/             # 仅 EE
```

责任规则：

- `apps/server` 与 `apps/web` 是彼此隔离的 composition root；只做依赖注入、贡献挂载、启动与关闭，不承载领域规则、SQL 或手写 package-to-module 映射。
- Platform 不依赖 agent/resources/apps；agent 不依赖 resources；resources 不依赖 apps 或具体授权实现；EE 只依赖 CE 公开 exports，CE 不反向依赖 EE。
- `db/`、`deploy/` 是仓库级交付物。模块通过显式 manifest/migration/env contribution 接入，不把仓库级 runner 变成业务模块。
- 当前根 `src/`、`web/` 和 `drizzle/` 在垂直切片完成前仍是运行基线；目录目标不授权先搬空再补功能。

## 2. 资源模块的同生命周期交付面

资源模块不是裸 service，而是按真实需求共同交付的 domain、services、repository/adapters、schemas、route、db/migration、Web contribution、manifest、tests 与 README。不是每个资源都必须立即拥有每一层；没有真实用例时不创建空抽象。

```text
packages/resources/<resource>/
├── src/
│   ├── domain/          # 实体、值对象、状态机（按需）
│   ├── services/        # actor-aware Facade 与 actor-free Domain Service
│   ├── repositories/    # 查询、持久化、事务原语
│   ├── adapters/        # 外部协议或 provider 差异（按需）
│   ├── routes/          # /app route contribution
│   ├── schemas/         # 协议 DTO、校验和独立转换
│   ├── module.ts        # module factory/contribution
│   └── index.ts         # server 根公开入口
├── db/
│   └── index.ts         # server-only schema/migration 公开入口
├── web/
│   └── index.ts         # browser-only 公开入口
├── package.json
├── fenix.module.ts
└── README.md
```

三个公开面必须物理隔离：

| export | consumers | may expose | must not expose |
| --- | --- | --- | --- |
| `.` | server modules/apps | 领域 DTO、Facade/Domain Service factory、server ports | repository 内部、私有 schema、Web 实现 |
| `./db` | migration/schema tools、EE 外键 schema | 该 package 拥有的表和 migration contribution | server service、Web 值、其他 package 表的再导出 |
| `./web` | browser registry/apps/web | API client、hook、页面、i18n、browser-safe contribution | service、repository、adapter、DB、Node-only 值 |

有 resource schema 的 target package 必须提供 `./db`。EE schema 可从固定 CE package 的公开 `./db` 引用外键目标，但不得穿透 `src/**`、re-export CE table 或把 CE schema 加入 EE generator input。浏览器不得导入 `./db`；根入口不得把 server 值 re-export 给 `./web`。

跨 package 只通过 package 名和 `package.json#exports` 导入；相对路径只限同 package。每个直接 import 都必须在消费 package 声明 workspace dependency，不能依赖根 workspace 偶然提升。是否抽取新 SDK 或 port 取决于替换、多实现、循环或第二个真实用例，而不是目录形式。

## 3. 三类依赖必须分开

| dependency kind | 表达什么 | owner / 验证 | 不表达什么 |
| --- | --- | --- | --- |
| workspace/package dependency | 实际 TypeScript 直接 import | `package.json` 与边界 CI | 启用顺序、运行时替换 |
| capability `requires` | 装配器必须注入的可替换运行能力 | manifest + assembly validator | 普通资源 Domain Service 依赖 |
| concrete module `dependsOn` | 当前 factory 启动必须同时启用的直接 module | manifest + topological assembly | TypeScript 全部依赖、传递闭包 |

所有源码中 import manifest/assembly 类型的 package 都直接依赖 platform SDK。Generated registry 属于对应 app package；registry 静态 import 的每个 server module 或 browser `./web` package 都是 app 的直接 dependency。仅切换已内置 assembly 候选不改变该集合。

资源间依赖遵循领域方向：保存关联只保存 stable ID；运行或写入前需要 B 的领域信息时，A 依赖 B 包根 actor-free Domain Service；跨资源事务/删除由动作 owner 的 Facade 或 app use case 编排。不得导入 B 的 table/repository、通过 route 调 route，或让被引用资源反向依赖引用者。

AgentConfig 能力簇的资源依赖方向由 ARC-03 最终冻结；本稿仅记录草案：AgentConfig 可依赖稳定的 Model、Skill、MCP、Knowledge、Memory、Environment、Site App 服务，Provider 由 Model 封装，Agent Node 由 Environment 封装，Sandbox 自己依赖 Agent Node。具体值只在根 identity 表维护，并明确标为 ARC-03 draft。

## 4. Capability 与 cardinality

整体目标当前规划以下五类装配能力。ARC-02 冻结 capability/cardinality 机制以及 `access-control`、`observability` 两个平台 slot；runtime、instance starter 与 engine 的具体 role/ID 由 ARC-03 最终确认：

| capability role | cardinality | resolution invariant |
| --- | --- | --- |
| authorization provider | singleton | assembly 恰选一个 enabled provider；CE/EE implementation ID 不同但占同一 slot |
| runtime provider | singleton | 恰选一个；不能由资源依赖默认 implementation ID |
| instance starter provider | singleton | 恰选一个 agent-side executor；app adapter 再实现 resource-local port |
| observability provider | singleton | 恰选一个 ingestion implementation |
| agent engine | multi-provider | 汇总 enabled providers，按 engine type 选择；零匹配或同 type 重复均启动失败 |

四个 singleton 由 assembly binding 选择；engine providers 不占 singleton slot。资源 module 无 edition 条件，默认与 EE provider 可同时存在 registry，只有当前 profile 绑定其中一个。九类资源不得为了可选安装或注入便利增加 slot。平台 manifest/profile schema 由 FND-03 落地；资源与 Agent manifest 在 ARC-03 后由所属 task 添加。

Module ID、package ID、capability role 和 Web ID 是独立 namespace。SDK/app 不注册 module；只有提供生命周期、贡献或 capability implementation 的单元需要 manifest。Manifest 的 `dependsOn` 不替代 package dependency，反之亦然。

### 4.1 Module kind 与最小声明形态

ARC-02 冻结三个 module kind：

| kind | responsibility | examples |
| --- | --- | --- |
| `platform` | 为 app 和业务模块提供可替换的基础能力 | AccessControl、observability |
| `runtime` | Agent 执行、实例或引擎 provider；具体 ID 由 ARC-03 | runtime、instance、engine |
| `resource` | 资源领域、route、DB 与可选 Web contribution；具体 export 由 ARC-03 | AgentConfig、Skill、MCP |

App 与纯 SDK 的 module ID/kind 均为 `none`；Web 是 module 的 browser contribution，不是第四种 kind。

FND-03 可以细化 schema，但不能改变以下最小语义：

| declaration | required meaning |
| --- | --- |
| Module manifest | stable module ID、kind、direct `dependsOn`、provides/requires、env definitions、server lifecycle/contributions、可选 Web contribution |
| Assembly profile | singleton capability bindings、enabled modules/resources、Web Shell 与 enabled Web contributions；只引用 registry 内 ID |
| Env definition | owner module、key、validation schema、default、secret、restart-required 与用途 |

Manifest/profile 不得包含任意 import path、URL、npm package 名、表达式或代码。完整 TypeScript/Zod 字段名、错误文案和序列化格式归 FND-03 实现，不在 ARC-02 冻结。

## 5. Server 与 Web registry 隔离

构建扫描只接受受版本控制、已编译且 surface-safe 的 workspace 候选；EE 额外扫描固定 CE submodule。同一次 generation 产出两个互不共享 value graph 的 registry：

```text
apps/server/src/generated/server-module-registry.ts
  -> server roots and manifests only

apps/web/src/generated/web-contribution-registry.ts
  -> declared browser-safe ./web contributions only
```

Server registry 可收录所有合法 server module；Web registry 收录构建产物中的全部 browser-safe candidate，再由 assembly 选择启用项。Web 绝不 import package 根、`./db`、server manifest value 或共享 server barrel。Generator 完成后校验 app dependency 与浏览器 import graph。

Assembly 只能选择 registry 已内置候选。切换既有 profile 不重新生成 route tree 或 app registration；新增/删除 module、manifest/export 变化才需要 regenerate + build。TanStack Router 的薄 adapter 也须预先进入 bundle，运行时不注入或下载 route code。

## 6. Assembly 与 bootstrap

Profile 位于受部署平台保护的固定位置，只允许中性的 module/capability/Web/Shell selection；不得包含文件路径、URL、npm package 名、表达式或代码片段，也不能指定新的加载位置。解析过程依次验证：

1. profile 结构与重复 ID；
2. registry 存在性、module kind 与 surface；
3. direct `dependsOn` 和 capability cardinality；
4. env definition 冲突及 migration/dependency preflight；
5. 拓扑创建、route/Web contribution 挂载与 lifecycle registration。

Bootstrap 拓扑固定为：

```text
observability
  -> AccessControl + engine providers
  -> agent runtime
  -> instance starter provider
  -> dependent resources
  -> app contributions
```

同层且无直接依赖的 module 可并行初始化；关闭按反向顺序。Runtime 必须在 engine registry ready 后创建；InstanceManager/starter 在 runtime 后；依赖 starter 的资源再装配。App bootstrap 不直接 new 某个 concrete module，也不复制 parser。

已有 module 的启停、替换和组合可只改受控 profile；新增 module 仍需提交 package、manifest、registry 生成结果、依赖与构建验证。该静态机制不等于运行时插件市场。

### 6.1 装配解析与生命周期故障

装配必须先完成全量验证，再开始有副作用的 module creation。
未知 module、重复 ID、kind 错配、缺失 direct dependency、singleton 多选/漏选或 engine type 冲突都属于启动前配置错误。
不能先启动部分 module，再在挂载 route 时才发现 profile 无效。

Module 创建失败时，bootstrap 按已成功创建的反向拓扑执行有界关闭。
关闭失败保留 module ID、阶段和 primary failure，上报但不跳过后续可独立释放项。
Readiness 只有在 required module、migration preflight、route 与 transport 都 ready 后才能成功。

Profile 变更的回滚单位是受验证的 app image、registry 与 profile 组合。
不能把新 profile 指向旧 image 未内置的 module，也不能用路径或 package name 绕过 registry。
发布记录必须能还原 image revision、profile revision、启用 module 与 provider binding。

### 6.2 Manifest 高度

Manifest 只描述装配所需稳定 metadata 与 contribution，不成为万能 service locator。
Factory 只获得自身声明且已解析的依赖/env/observability，不遍历全局 container 寻找可选能力。
Lifecycle hook 必须有明确 owner、timeout、取消和资源释放语义。
Route、migration、env 与 Web contribution 的声明只引用本 package 公开 surface。

完整字段、Zod schema、错误文案、生成格式与 optional module 规则归 FND-03。
ARC-02 只要求平台实现证明 namespace、cardinality、direct edge、surface isolation 与 fail-fast；Agent/resource capability 的具体 ID、输入和生命周期由 ARC-03/所属实现 task冻结。

## 7. Env 与 secret

一个 server 进程只统一读取、校验环境变量一次。模块声明真实部署级 env，由 app 汇总已启用 manifest 后校验并以构造参数注入；业务代码和 repository 不自行读取 `process.env` 或加载 `.env`。资源名称、模型选择、Skill、发布状态等运行时业务配置存数据库，不是 env。

Env definition 至少表达字段名、校验 schema、默认值、secret/restart-required、owner module 与用途。同名定义在 schema、default 或 secret 属性上冲突时启动失败；EE 可追加定义，不能静默改变 CE 同名变量。Server host env 只含端口、日志级别、shutdown timeout 等进程级字段。

`apps/web` 不读取 server env，也拿不到 secret。少量公开构建配置使用独立 web env；适合运行时变化的品牌、导航和 feature selection 从受控 API/assembly projection 获取。

部署模板只有变量名、说明与非敏感样例；真实 secret 来自平台 secret store、受控文件或容器机制。Provider、Sandbox 与子进程只得到显式 allowlist，不继承全部进程环境。Token、密码、连接串和 secret value 不进入源码、profile、日志、错误、fixture、浏览器或诊断包。

## 8. 验收责任

FND-01 落实 workspace metadata与基础边界，FND-02 把禁止方向和内部路径导入变成 CI，FND-03 落实平台 manifest/registry/assembly/bootstrap，PLT-04 落实 env loader，PLT-03 落实 observability。任何实现都必须以根 identity 表的阶段状态为准，不能把 ARC-03 draft 误报为当前能力。

边界测试至少证明：CE 不反向依赖 EE；resource/agent/platform 方向正确；跨包只走 exports；Web import graph 无 server/db 值；未知 ID、缺 dependency、slot 冲突与 engine type 冲突 fail-fast；切换 profile 不触发远程代码加载；shutdown 释放已启动模块。

Review package 时还要逐一回答：

- 它是 SDK、app、resource、provider 还是有生命周期的 module；
- 每个 public export 是否有真实 consumer，是否错误暴露内部 adapter/schema；
- package dependency、capability requirement 和 concrete module edge 是否各自准确；
- Web contribution 是否只能从 browser-safe subpath 到达；
- env/secret 是否由 bootstrap 注入，是否有关闭与失败释放 owner；
- EE 使用它时只需固定 CE public export，还是会被迫穿透 submodule。

任何一项无法回答都不能仅靠 manifest 声明为“模块化完成”。
