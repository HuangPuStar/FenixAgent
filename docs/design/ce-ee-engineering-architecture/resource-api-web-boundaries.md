# 资源、API 与 Web 边界

> 本文是 Resource Facade/Domain Service/repository、HTTP/协议入口、外部合同迁移、Web Shell/contribution 与扩展放置的 canonical detail。ARC-02 冻结通用 platform/app 边界；AgentConfig 和其他资源的具体 package/route/Web identity 由 ARC-03 冻结，草案值只见[根索引](../ce-ee-engineering-architecture.md#4-identity-summary)。

## 1. 资源后端分层

默认依赖方向：

```text
route / external adapter / trusted task caller
  -> actor-aware Resource Facade
  -> actor-free Domain Service / repositories / adapters
```

| layer | owns | must not do |
| --- | --- | --- |
| route / protocol adapter | 协议认证接入、请求校验、DTO 转换、Facade 调用、响应/错误映射、OpenAPI metadata | 访问 DB、拼跨表事务、调用另一 route、承载授权规则 |
| Resource Facade | actor 授权、动作与状态、引用选择、跨资源编排、事务或补偿、幂等/并发、审计 | 暴露 claims/DB row；把领域规则下放 route |
| Domain Service | actor-free 领域规则、受信任内部查询与解析 | 接收 actor、调用 AccessControl、读取 member/role 或原始 `resource_context` |
| repository | 持久化查询、条件组合与事务原语 | 业务授权、跨资源编排、调用 service |
| adapter | 外部协议、存储或 provider 差异 | 隐藏领域决策或变成第二 service |

HTTP、Web、外部 API 和带资源身份的任务必须进入 Facade。Route 不得直调 Domain Service。迁移、运维与已授权的后端模块可使用明确的 actor-free Domain Service，但这不是第二套 HTTP API，也不能伪造 system actor。

资源之间只复用包根公开能力。创建/编辑关联时，发起动作的 Facade 必须在服务端重验主体是否可选择被引用资源，不能信任前端下拉列表；运行时先授权顶层 AgentConfig `use`，再用 actor-free service 解析已持久化引用，不重复授予底层资源独立 read 权限。引用缺失、禁用、失效、版本冲突或凭证不可用仍在副作用前失败。

列表有两条明确路径：actor-facing list 强制使用 AccessControl 下推约束；受信任内部全量查询使用独立命名的 actor-free port。不存在 optional access。授权条件与业务条件、排序、分页、cursor、total 在同一 DB 查询执行；禁止全量读取后内存过滤。详细不变量见 [AccessControl 契约](./access-control-contract.md)。

资源 DTO 由各 package 自己拥有。调用者只复制所需最小值，不跨边界共享可变领域对象、repository model、schema 或 provider adapter。Secret resolver 只从 server 根入口提供，绝不从 `./web` 暴露。

## 2. 资源关系与依赖选择

资源默认独立，依赖由领域关系而非目录邻近决定：

| relationship | allowed | forbidden |
| --- | --- | --- |
| 仅保存关联 | 保存 B 的 stable ID；A 拥有自己的 binding/index/snapshot | 以 name 关联；导入 B 的表/repository |
| 写入、发布或运行前校验 B | 调用 B 根入口公开的 actor-free Domain Service | 读取 B 权限表；构造 B repository；调用 B route |
| 跨资源事务、删除、批量协调 | 动作 owner 的 Facade 编排；无单一 owner 时由 apps/server use case 组合 | repository 调 service；被引用 B 反向依赖 A |

直接依赖一个稳定 service 优于为每个资源制造 resolver interface。只有实现可替换、多实现、循环依赖，或第二个真实调用者只需要极小稳定语义时，才导出最小 port。公共概念也不能仅为打破一次循环就堆入 platform SDK；可先把协调流程上移到 composition root。

## 3. Route 与协议 namespace

`apps/server/src/routes` 只保留协议聚合器；领域 route 随资源 package 交付。Prefix 按消费者和合同义务分离：

| prefix | consumer | rule |
| --- | --- | --- |
| `/app/*` | 新控制台与受控应用调用方 | 新资源架构目标；统一认证接入、DTO、授权、错误映射与 contribution |
| existing `/web/*` | 尚未迁移的控制台 | 每个资源切到 `/app` 后删除对应内部路径 |
| existing `/api/*` | 外部系统、API Key、OpenAI-compatible 消费者 | 稳定外部合同；逐 endpoint 决定保留、版本化或退役 |
| `/acp/*`、`/mcp/*`、`/hooks/*`、WS/SSE | 协议或内部桥接 | 独立协议，不作为第二套资源 CRUD API |

AgentConfig 的 exact route/browser/Web identity 在根表唯一维护。`:id` 永远是 stable ID；name 只用于展示/搜索。非 CRUD 动作采用资源 action suffix，但 route identity 不自动定义产品语义，尤其 `run` 的响应与生命周期仍由产品/协议 owner 决定。

`/app` 不是既有外部 `/api` 的隐式替代。每个现存外部 endpoint 单独识别消费者、认证、版本、response/error、rate limit、OpenAPI、观测、停用窗口与回滚后，才能改变合同。协议兼容是正式义务，不因“删除优于兼容”的内部重构原则而消失。

## 4. 外部 API 的原子重接

AgentConfig 权威 Facade 切换时，所有保留合同的 external adapter 必须与新 `/app` 和内部调用方在同一切换窗口原子改接同一 Facade。规则是：

1. 新 Facade、数据与授权路径先具备等价 contract tests；
2. `/app`、Web client、内部任务和每个保留 external adapter 在一个受控发布窗口切换；
3. 验证入口只指向新 Facade、没有旧 repository/service 写入后，删除旧 service；
4. external adapter 保留既有协议 DTO/response 时是正式协议边界，不是 deprecated shim；
5. 禁止双写、长期转发到旧 service、复制业务规则或让 external route 成为第二权威实现。

外部合同待定只阻塞 endpoint 的改变或删除，不阻塞上述重接、内部 `/web` 删除和旧 service 收敛。若决定改变合同，先产出 owner 批准的 compatibility artifact，并修正协作计划中冲突的验收文字；必要时再评估 ADR。

ACP、MCP、Webhook、SSE 与 WebSocket 迁移只改变代码 owner 和依赖注入；没有独立协议决策时，不改变前缀或消息契约。Agent 通信必须继续复用现有 relay/ACP 权威链路，不创建平行 JSON-RPC stack。

## 5. Web composition

前端分为版本 Shell、薄 route adapter 与资源 `./web`：

```text
apps/web/src/
├── app.tsx              # providers、error boundary、contribution registration
├── routes/              # TanStack Router 薄适配；只接参数与页面
├── generated/           # browser-only contribution registry
└── shell/               # 首页、布局、导航、品牌、全局 provider

packages/resources/<resource>/web/
├── api/                 # /app client
├── pages/               # 领域页面与容器
├── components/          # 领域组件
├── hooks/               # 领域异步状态
├── i18n/                # 领域文案
└── contribution         # 导航、页面 metadata、route target、权限提示
```

Shell 是产品版本的最终组合，不是资源 package。CE Shell 持有基础首页/布局/导航；EE 若整体不同，在自己的 app 中实现完整 Shell，而非用 hook 覆盖 CE Shell。只有至少两个独立 Web app 真正复用稳定 Shell 时才抽成 package；`apps/web` 始终是最终选择者。

TanStack Router 保持文件路由。构建产物预先包含 browser-safe candidate 的薄 adapter；assembly 只选择已内置 contribution。运行时不注入 route 或远程脚本。Shell 可读取启用 contribution 形成导航和页面，但资源页不能反向控制全局布局，也不能导入 server/db。

前端差异按最小范围处理：

1. 无差异：EE 复用 CE resource `./web` 页面与 client；
2. 局部差异：复用 DTO/client/通用组件，在 EE resource Web 增加领域动作；
3. 页面流程整体不同：EE 提供替代 resource page，由 EE app 静态选择；
4. 品牌、导航、首页、布局或全局交互：归 app Shell；
5. 后端资源扩展与 Web 扩展独立选择，不能靠复制整个 CE Web app。

每个用户流程覆盖 loading、empty、error、retry、unauthorized、success feedback 与可访问性；可见字符串进入 i18n。UI 隐藏仅改善体验，服务端 Facade 授权才是安全边界。Web API 一律经 request layer，不直接访问数据库或 server service。

## 6. CE、EE 与客户扩展放置

| need | placement | forbidden shortcut |
| --- | --- | --- |
| 替换身份、租户、通用资源授权 | platform 的 AccessControl provider，由 app singleton slot 替换 | resource 读取 CE role/member 或写 edition branch |
| 通用 AccessControl 缺少所有资源都需要的语义 | 经 EE-C/CE 评审演进公共 contract | optional 客户字段、类型强转、运行时方法探测 |
| 某领域独有 policy，如发布/审批 | 消费领域定义窄 policy port，app 显式注入 | 给所有资源的 AccessControl 增加领域方法 |
| 单客户合规流程 | 客户 EE resource/module | 污染 CE 或普通 EE contract |
| EE 资源状态/字段 | EE 自有 schema、Facade composition、route/Web contribution | 修改 CE 表放 EE 字段，复制 CE CRUD |
| 新引擎 | engine multi-provider contract | 在 AgentConfig/runtime 写 provider 分支 |
| 新存储或外部系统 | 所属 repository/provider adapter | domain 中按 database/provider type 分支 |

通用授权、领域窄策略、客户策略三分法是稳定规则；本文不为示例编写具体接口。新增 policy 必须说明输入、输出、拒绝、审计与 contract tests，但其实现级签名由真实领域 task 冻结。

## 7. 安全、失败与可维护性

### 7.1 协议错误与领域错误

Facade/Domain Service 产生稳定领域分类，route adapter 负责映射当前协议的 status、envelope 和公开 message。
同一个领域拒绝在 `/app`、保留 `/api` 或任务调用中可以有不同协议表示，但不能改变是否执行副作用。
Route 不捕获后返回伪成功、空集合或内部 Error 文本。
Anti-enumeration、401/403/404 的具体映射尚未决定，不能由某个 resource route 单独创造先例。

Adapter 只映射已知安全字段。
未知错误保留 request/trace/module/operation 的内部诊断，外部使用脱敏稳定 fallback。
Provider 原始响应、SQL、路径、credential 和 opaque authorization value 不进入 response。

### 7.2 事务与并发 owner

Facade 界定业务 transaction 或 saga；repository 只提供所属存储的原语。
同一数据库内的 aggregate/binding/access metadata 按 owner-approved 边界原子提交。
外部 provider、文件、archive、runtime 或 remote node 不能伪装成同一 ACID transaction。
异构步骤必须有明确 primary action、幂等逆操作、有限 cleanup 与 reconciliation owner。

Update/binding replace 需要 version 或等价并发控制，不能沿用无保护 delete-then-insert。
Retry 只对明确可重试状态执行并有次数/时间上限；冲突和权限拒绝不自动重试。
Idempotency namespace 从可信 tenant/resource/operation context 派生，外部只提供 client component。
具体 key、锁、transaction API 与表字段由资源实现 task 冻结。

- 可信 actor 只由当前认证/AccessControl 边界产生；route body、query、queue payload 不得自称角色、tenant、scheduled 或 system。
- 外部错误不泄漏内部 schema、SQL、路径、secret 或 provider 原始响应；诊断上下文保留在受控观测通道。
- 跨资源写在同事务域原子；异构系统用可重试、可观测补偿。不得吞错或宣称分布式 ACID。
- 同一资源、route 或表任一时刻只有一个权威写实现。迁移窗口可以短暂共存可读适配，但不能并行拥有业务规则。
- Package API 只稳定真实消费者所需语义。禁止跨包内部导入、共享可变状态或为了测试增加全局 setter。

## 8. 验收关注点

资源 task 至少验证 actor-facing 入口不能绕过 Facade、内部 Domain Service 不可被 route 直调、关联选择服务端重验、list 下推、稳定 ID、事务/补偿和审计。Web task额外验证 browser import graph、关键异步状态、路由参数与 API DTO 对齐、生产 build。

切换验收应对所有旧 route/service/page/caller 做可审计搜索；external endpoint 按合同决策分类为保留并重接、版本化或退役。任何未分类消费者、第二写路径或敏感数据泄漏都应停止切换并回滚到仍兼容当前 schema 的版本。

Contract evidence 至少覆盖：

- route 在未认证或参数无效时不调用 Facade；
- Facade 在授权/引用失败时不触发 repository mutation 或外部副作用；
- Domain Service 只能由受信任 server dependency graph 到达；
- external adapter 与 `/app` 对同一领域结果保持各自协议合同；
- Web 页面不直接 import server root/db，也不维护第二份权威业务状态；
- 客户/EE 扩展通过明确领域 policy 或静态 contribution 组合，不 fork CE 核心流程。

这些证据保护边界，不要求测试内部方法调用次数或冻结构造器形状。
