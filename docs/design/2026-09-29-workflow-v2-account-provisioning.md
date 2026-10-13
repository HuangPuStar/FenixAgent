# Workflow V2：平台上游账号供给（自助注册）设计

> 日期：2026-09-29（本批文档前缀）· 状态：**已实现并提交**（`54831be59`，2026-09-30）；上游取证与本文校准时间 2026-09-30
> 设计依据：[2026-09-29-workflow-v2-upstream-studio-bridge.md](./2026-09-29-workflow-v2-upstream-studio-bridge.md) §3.1（平台整体映射 1 个上游用户）、[2026-09-29-workflow-v2-interface-freeze.md](./2026-09-29-workflow-v2-interface-freeze.md) §4（会话接口）
> 实现落点：`packages/resources/workflow-v2/src/server/services/platform-account-registration.ts`（新增）、`.../platform-account-bootstrap.ts`（编排改动）；env 描述文案同步 `fenix.module.ts` 与三份生成样例（`.env.example`、`deploy/env/rcs.example`、`docker/prod/.env.example`）。**本轮未新增 env**。
> 上游代码基准：`/Users/konghayao/code/ai/workflow-studio` @ `01aa6726b37b3774e24dc6cf26e08bfbea4dda05`（2026-09-30 09:00），其 `backend/**` 无本地改动——本文所有上游行号即该 commit 的行号。

## 1. 问题与结论

**问题**：workflow-v2 把整个平台映射成 **1 个固定上游用户**，全部出站调用都带这个账号的 `session_key`（设计 §3.1）。而该账号此前**必须先存在**：上游登录端点不自动建号，邮箱不存在时直接返回 `700000003`（`backend/domain/user/service/user_impl.go:67-75`）。部署方除注入邮箱/密码 env 外，还得先在上游手工建号，否则首次引导（第一个租户建 App）必然失败。

**结论（已落地）**：把「确保账号存在」做成**引导/首启编排层的一步**——`bootstrapPlatformAccount()` 在登录**之前**调一次注册端点 `POST /api/passport/web/email/register/v2/`（`platform-account-registration.ts:31`、`platform-account-bootstrap.ts:231`），邮箱已存在（`700000001`）按成功处理，随后照常走原有登录链路。

三条口径同时成立：

| 口径 | 内容 | 依据 |
|---|---|---|
| 不改上游 | 只加一个上游已存在、默认开放的 HTTP 调用；不改上游任何文件、不加 env、不动会话链路 | 本轮 diff：1 个新服务文件 + 引导层 1 处编排 + env 描述文案 |
| 只为「首启」建号 | 注册只发生在**台账无行**的引导路径；`login()` / `ensureCookie()` / 鉴权失败重登分支都不触达注册 | `platform-account-bootstrap.ts:326-329`、`upstream-session.ts:460-482`、`upstream-client.ts:246-269` |
| 部署不再需要人工建号 | 注册默认开放、无需验证码与邮箱激活、注册即自动建个人空间 | §2.3 |

## 2. 调研结论（上游 `file:line` 取证）

### 2.1 不存在 master key / 内部服务令牌 / 免登录注入身份

上游把中间件挂在全局（`backend/main.go:93-101`），请求先被分类：默认 `WebAPI`，命中 OpenAPI 路径集合才是 `OpenAPI`（`backend/api/middleware/request_inspector.go:36-48`、`:31-33`）。`SessionAuthMW` 只处理 `WebAPI`：

- 免 cookie 的路径是**硬编码白名单**，只有两条：`/api/passport/web/email/login/`、`/api/passport/web/email/register/v2/`（`backend/api/middleware/session.go:37-40`、`:50-53`）；
- 其余 `WebAPI` 请求从 cookie 取 `session_key`，为空即 `HTTP 401 missing session_key in cookie`（`session.go:55-60`）；非空则 `ValidateSession`（`session.go:63`），通过后把 session 写进请求上下文（`session.go:70-72`）。

**身份写点只有两处**，没有「从请求头取身份」的分支：

| 写点 | 位置 | 前置条件 |
|---|---|---|
| `ctxcache.Store(…, SessionDataKeyInCtx, session)` | `backend/api/middleware/session.go:71` | cookie 里的 `session_key` 通过 HMAC 校验**且**能在 `user` 表按该列查到行（`backend/domain/user/service/user_impl.go:376-402`） |
| `ctxcache.Store(…, OpenapiAuthKeyInCtx, apiKeyInfo)` | `backend/api/middleware/openapi_auth.go:154` | `Authorization: Bearer <PAT>` 命中数据库里的 API key 记录（`openapi_auth.go:122-150`） |

业务代码取身份只从请求上下文读（多经 `ctxutil`），没有会话数据即 panic（`backend/application/base/ctxutil/session.go:36-43` 的 `MustGetUIDFromCtx`，无会话时 `panic("mustGetUIDFromCtx: sessionData is nil")`）——**没有「无凭据但被信任」的旁路**。

### 2.2 被证伪的备选

| 备选 | 结论 | 证据 |
|---|---|---|
| **OpenAPI PAT**（`Authorization: Bearer pat_…`） | **无效**：PAT 校验只覆盖固定路径清单与少量正则，全部落在 `/v1/`、`/v3/`、`/open_api/` 三个前缀下。我方要用的 `/api/passport/**`、`/api/draftbot/**`、`/api/playground_api/**`、`/api/workflow_api/**` 都不在其中，一律按 `WebAPI` 走 session 校验 | `backend/api/middleware/openapi_auth.go:40-62`（清单）、`:64-75`（正则）、`:94-111`（判定）；默认分类见 `request_inspector.go:38` |
| **`impersonate_coze_user`**（换取「以该用户身份」的令牌） | **无效**：路由在 `/api/permission_api/coze_web_app/impersonate_coze_user`（`backend/api/router/coze/api.go:301-302`），本身是 `WebAPI` → **调用它就需要已登录 cookie**；实现里 `userID := ctxutil.GetUIDFromCtx(ctx)` 同样来自会话。产物是 15 分钟临时 PAT（`time.Now().Add(time.Second*60*15)`、`AkTypeTemporary`），**适用范围仍受上面的 OpenAPI 白名单限制** | `backend/application/openauth/openapiauth.go:116-140`、`backend/application/base/ctxutil/session.go:36-43` |
| **种子 / 默认管理员账号** | **不存在**：MySQL 初始化脚本没有任何 `user` 行插入（`docker/volumes/mysql/sql_init.sql`、`docker/volumes/mysql/schema.sql`）；`AdminAuthMW` 只做「邮箱在不在 `AdminEmails` / `ALLOW_REGISTRATION_EMAIL` 列表里」的**角色判定**，不创建账号 | `backend/api/middleware/session.go:78-112` |
| **只改 `frontend/**` 拿到服务端身份** | **无效**：前端产物无法铸造被服务端接受的会话——签名密钥不在前端产物里（它硬编码在上游 Go 源码中，安全性问题见 §4），且即使签出合法键，也还必须出现在 `user.session_key` 列才会被认 | `backend/domain/user/service/user_impl.go:376-402`、`:644-681` |

合起来：**要让我方以平台身份出站，唯一合法路径是先有账号、再用账号凭据登录**——要么人工建号，要么自助注册，即本轮选定的路线。

### 2.3 选定路线的上游事实

| 事实 | 内容 | 证据 |
|---|---|---|
| 注册端点 | `POST /api/passport/web/email/register/v2/`，请求体最小集 `{email, password}` | `backend/api/router/coze/api.go:285-288`；请求模型 `backend/api/model/passport/passport.go:777-780` |
| 免 cookie | 与登录同属白名单里**仅有的两条**免 cookie 路径 | `backend/api/middleware/session.go:37-40` |
| 默认开放 | `DISABLE_USER_REGISTRATION` 不为 `"true"` 即允许注册 | `backend/bizpkg/config/base/base.go:67`、`backend/application/user/user.go:93-104`；样例部署文件默认留空（`docker/.env.example:259-261`） |
| 无验证码、无邮箱激活 | 应用层流程只有「邮箱格式校验 → 允许注册判定 → 建号 → 直接登录」，没有验证码或激活步骤；登录也不校验 `user_verified` | `backend/application/user/user.go:54-91`、`backend/domain/user/service/user_impl.go:67-110` |
| 注册即建个人空间 | 建号时未指定 `space_id` 就自动 `CreateSpace("Personal Space")` 并挂到该用户 | `backend/domain/user/service/user_impl.go:288-313` |
| 注册即下发会话 | 注册内部顺带完成一次登录，并 `Set-Cookie: session_key=…` | `backend/domain/user/service/user_impl.go:82-90`、`backend/api/handler/coze/passport_service.go:58-63` |
| 登录**不会**自动注册 | 邮箱不存在与密码错误共用 `700000003`（`ErrUserInfoInvalidateCode`） | `backend/domain/user/service/user_impl.go:67-75`、`backend/types/errno/user.go:29` |
| 邮箱已存在 | `700000001`（`ErrUserEmailAlreadyExistCode`） | `backend/domain/user/service/user_impl.go:252-260`、`backend/types/errno/user.go:27` |
| 注册被禁 | `700000008`（`ErrNotAllowedRegisterCode`） | `backend/application/user/user.go:67-70`、`backend/types/errno/user.go:34` |
| 鉴权失败 | `700012006`（`ErrUserAuthenticationFailed`）——与我方常量 `UPSTREAM_AUTH_FAILED_CODE` 同值（`upstream-session.ts:53`），**与登录被拒的 `700000003` 不是一回事** | `backend/types/errno/user.go:25` |
| 业务错误的 HTTP 形态 | 带业务码的错误一律 `HTTP 200 + {code,msg}`；没有业务码的失败（含 DB 层异常）才是 `HTTP 500 + {code:500}` | `backend/api/internal/httputil/error_resp.go:43-54` |

**上游已知缺陷（直接影响我方口径）**：

1. **注册白名单读错 env 变量**：`AllowRegistrationEmail` 被赋成 `DISABLE_USER_REGISTRATION` 的值（`backend/bizpkg/config/base/base.go:79`），而消费点在 `backend/application/user/user.go:98-103`。后果：开关一打开，白名单内容就是 `"true"` 这个串，**任何真实邮箱都命中不了**——即「开关 + 白名单」组合必然表现为「注册全关」。因此**不能依赖白名单**来做到「只允许我方邮箱建号」（详见 §6）。
2. **登录 handler 明文打印会话值**：`logs.Infof("[PassportWebEmailLoginPost] sessionKey: %s", sessionKey)`（`backend/api/handler/coze/passport_service.go:105`）。这是上游事实，我方无法从代码侧消除，只能在部署侧收口（§6）。
3. **注册查重无锁无事务**：`Create` 先 `CheckEmailExist` 再插入（`backend/domain/user/service/user_impl.go:252-260`），库侧只有 `user.uniq_email` 唯一索引兜底（`docker/volumes/mysql/schema.sql:96`）；真正并发时后到者撞索引，报错走「无业务码」路径 → `HTTP 500`（§3.5）。

## 3. 落地口径（与实现一致）

### 3.1 注册放在引导层，而不是 `login()` / `ensureCookie()`

`login()` / `ensureCookie()` 是**每一次上游调用的必经之路**（`upstream-client.ts:246-269` 每次调用先 `ensureCookie()`，鉴权失败还会 `invalidate()` + 重登一次）。把注册挂在它们上面，等于把「env 里邮箱写错」这类配置错误变成**凭空建出的垃圾账号**（每次登录失败都建一个新号，且新号仍登不上，会无限制造上游垃圾数据）。

因此注册的唯一入口是 `bootstrapPlatformAccount()`——它是「首启」语义的持有者，只有它知道「台账没有账号行、需要现场确定账号身份」（`platform-account-bootstrap.ts:212-227`）。生产路径上它只被 `ensurePlatformAccount()` 在**台账无行**时调用（`platform-account-bootstrap.ts:326-329`），后者由租户 App 创建链路进入（`org-app-binding.ts:323`）。台账已有行时整条路径零出站（用例：`org-app-binding.test.ts` 的「台账已有账号行时 `ensurePlatformAccount` 不注册也不登录」）。

### 3.2 四态归一

`registerPlatformAccount()` **不抛错**，四种结果由返回值表达（`platform-account-registration.ts:39-54`、`:80-109`）：

| 结果 | 触发条件（实现判定） | 引导层动作 | 是否阻塞引导 |
|---|---|---|---|
| `created` | `HTTP 200` 且 `code === 0`（`registration.ts:102`） | `info` 日志，继续登录 | 否 |
| `already_exists` | `code === 700000001`，**不看 HTTP 状态**（`:100`） | `info` 日志，继续登录 | 否 |
| `registration_disabled` | `code === 700000008`（`:101`） | `warn` 日志，**仍继续登录** | 否（见 §3.3） |
| `failed` | 其余：未知业务码 → `detail = code=<n>`；响应非 JSON / 无数字 `code` → `detail = http=<status>`；请求未完成（超时 `timeout` / 网络 `network`）→ 带 `cause`（`:103-105`） | `warn` 日志（传输类失败附底层消息），**仍继续登录** | 否 |

失败语义的收口在登录**也**失败之后（`describeLoginFailure`，`platform-account-bootstrap.ts:190-210`）：

- `registration_disabled` → 原因 `registration_disabled`，文案点明「上游禁止注册（`DISABLE_USER_REGISTRATION` 已开启），且账号登录失败」——运维动作是「人工建号或打开上游注册开关」；
- `failed` → 原因 `registration_failed`，文案带上 `detail`；
- `created` → 仍归 `session_unavailable`，但文案写明「本次引导刚自助注册成功，但用同一对凭据登录仍失败」——它要查的是上游注册/登录的密码口径，而不是改 env 凭据；
- 其余 → `session_unavailable`。

> 前两态**不新增原因枚举值**是因为 `PlatformAccountBootstrapReason` 是导出类型、被另一条泳道的文档逐项列举；把差异放在错误文案里已足够支撑运维分流。`created` 与 `already_exists` 都是「账号已可用」，因此不单独区分原因。

### 3.3 注册被禁时不立刻判死，仍尝试登录

兼容设计：**「人工建号 + 上游关注册」的既有部署必须照常工作**。账号是否存在与注册是否开放是两件独立的事——若因为拿到 `700000008` 就拒绝引导，会把一个本来能登录的部署打死。

实现上就是「注册结果只记日志、不参与分支」：`switch` 里最后一态处理完照样走到 `await getUpstreamSession().ensureCookie()`（`platform-account-bootstrap.ts:234-260`）。用例：`platform-account-registration.test.ts` 的「上游禁止注册时账号若已存在，引导照常成功」。

### 3.4 注册响应里的 cookie 不被采信

上游注册会顺带 `Set-Cookie` 一个 `session_key`（§2.3），但引导**整条不读**：`platform-account-registration.ts` 只 `await response.text()` 读业务码，`Set-Cookie` 连解析都不做（`:23-25`、`:97`）。理由两条：

1. 会话只能由 `upstream-session` 持有——同一次引导出现第二条持有登录态的路径，会让「谁是唯一会话持有者」失效；
2. 上游按用户**只存一个** `session_key`（`user.session_key` 列，登录时覆盖写，`user_impl.go:96-100`），注册顺带下发的这份马上会被随后的登录覆盖，采信它只会制造短暂的分叉。

用例以「注册下发与登录下发不同的会话值」断言后续上游请求带的是**登录**那一份。

### 3.5 幂等与并发

- **幂等是我方收敛口径，不是上游保证**：上游对已存在邮箱返回 `700000001`（`user_impl.go:252-260`），我方把它当正常结果，因此**顺次**重复执行「确保账号存在」不会产生第二个账号；台账侧则就地更新（账号身份变更时连 `platform_user_id` 一起改写），表为空才插入（`platform-account-bootstrap.ts:286-310`）。
- **真并发**：两个副本同时首启时各注册一次，后插入者撞 `user.uniq_email` 唯一索引 → `HTTP 500` → 我方记 `failed`（只多一条告警）；账号已由另一方建出，随后登录照常成功，引导不失败、也不会多出账号（`platform-account-registration.ts:13-18`、`platform-account-bootstrap.ts:219-223`）。
- **测试覆盖的边界**：同进程并发首启（注册幂等 + 登录单飞 + 台账一行）有自动化用例；**跨副本真正同时注册**（撞唯一索引 → 500）没有自动化用例，只有实现注释与本节描述——真实形态未验证（见 §5）。

### 3.6 代码与用例索引

| 关注点 | 位置 |
|---|---|
| 注册报文、业务码判定、四态 | `src/server/services/platform-account-registration.ts:31,34,37,39-54,80-109` |
| 引导编排（注册 → 登录 → 取 space → 落台账） | `src/server/services/platform-account-bootstrap.ts:228-318` |
| 失败原因与文案 | 同上 `:59-77`（枚举）、`:190-210`（文案） |
| 会话持有与重登（**不含注册**） | `src/server/services/upstream-session.ts:460-482`、`:490-504` |
| 常规请求的鉴权失败分支（**不含注册**） | `src/server/services/upstream-client.ts:246-269` |
| 控制面只读/重登接口（**不含注册**） | `src/server/routes/web/platform-account.ts` |
| 用例 | `src/__tests__/platform-account-registration.test.ts`（8 条：首启建号、已存在幂等、注册被禁、未知码、网络失败、被禁但账号在、刚建号但登不上、同进程并发） |
| 用例（真库 + 零出站护栏） | `src/__tests__/org-app-binding.test.ts`（「台账已有账号行时不注册也不登录」） |
| env 描述文案 | `fenix.module.ts`（`WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` / `..._PASSWORD`）、三份生成样例 |

## 4. 备选方案 B：离线铸造静态会话键（**未采纳**）

### 4.1 上游事实（这条路为什么在技术上成立）

`session_key` 是 `base64url(JSON{session} ‖ HMAC-SHA256(JSON{session}))`，`session` 只含 `id`/`created_at`/`expires_at`（`backend/domain/user/service/user_impl.go:617-641`）。服务端校验是**双重**的：

1. **签名与过期**：`verifySessionKey` 用 HMAC 校验并在本地比对 `expires_at`（`user_impl.go:644-681`）；
2. **查列**：`ValidateSession` 再按 `session_key` 去 `user` 表查用户，查不到就不认（`user_impl.go:376-402`、`backend/domain/user/internal/dal/user.go:142-155`）。

而 HMAC 密钥是**硬编码常量**（`backend/domain/user/service/user_impl.go:613-614` 附近，本文不复制其值；表结构见 `docker/volumes/mysql/schema.sql:96` 的 `user.session_key` 列）。

### 4.2 方案与收益

给定上述事实，可以：离线铸造一个**远期到期**的签名键（可行性来自上一段的硬编码密钥），再对该账号执行一次 `UPDATE user SET session_key = <铸造值>`（列写入口径见 `dal/user.go:53-61`）。收益：

- **免登录**：不再调用 `/api/passport/web/email/login/`，不受注册开关影响，也不受密码口径影响；
- **无踢键**：我方不登录就不会覆盖自己那一个键；
- **多副本零协调**：不再需要登录租约与共享会话存储（`upstream-session-store.ts` 的租约/轮询整条链路可以退休）。

### 4.3 为什么不采纳（代价与风险）

| 风险 | 说明 |
|---|---|
| 依赖上游安全缺陷 | 唯一防线是硬编码密钥。上游把密钥改成可配置/轮换，方案当场失效 |
| 一改即全挂且**不自愈** | 没有登录回退路径：会话被拒时无法靠重登恢复，只能人工重新铸造 + 改库 |
| 需要 DB 写权限 | 部署方须额外授予对上游 `user` 表的写权限，扩大权限面 |
| 性质是伪造会话凭证 | 与「用合法凭据登录」有本质区别，合规需拍板（安全评审、责任边界） |
| 上游侧可观测性变差 | 上游日志/审计里不再有登录记录，出现问题时更难与上游对账 |

**未采纳 ≠ 永不采用**：若合规放行、且部署方愿意承担「上游升级即可能失效」的维护成本，可作为降级预案重开评估。

### 4.4 若采用，需要动的接口（先改冻结文档，再动代码）

| 需要改的位置 | 改法 | 理由 |
|---|---|---|
| `upstream-session.ts` | 增加**静态会话分支**：`ensureCookie()` 直接返回配置的键，跳过 `login()` 与跨副本登录租约 | 会话来源从「登录产物」变为「配置项」，`UpstreamSession` 的契约不变 |
| `upstream-session.ts` 的 `invalidate()` | **必须**改为「不可自愈告警」——告警 + 拒绝请求，**绝不回落到登录** | 一旦回落到密码登录，`UpdateSessionKey` 会覆盖 `user.session_key`（`user_impl.go:96-100`），静态键当场作废，之后两边互相顶键 |
| `probe()` | 探活失败不再能靠重登收敛，语义要改成「人工介入信号」 | 现有探活以「重登可恢复」为前提 |
| `platform-account-bootstrap.ts` | 注册步骤在该模式下无意义（账号由铸造脚本一次性建好） | 避免两套建号路径并存 |
| env 契约 | 需要新增「静态会话键」这类 env（且属密钥材料） | 属接口冻结面变更，**必须先改 [interface-freeze](./2026-09-29-workflow-v2-interface-freeze.md) §2.2** |

## 5. 已知边界与残留

以下都是**已知边界**（有上下文与影响范围），不是待办：

1. **邮箱拼错仍会在首启建出垃圾账号**。自助注册的固有代价：只要邮箱写错，首次引导就会按错邮箱建号。**影响范围**已尽力收窄——注册只在「台账无行」的引导路径发生，常规登录失败路径不触达（`platform-account-bootstrap.ts:212-227`），因此整条部署生命周期最多建错一次，不会持续制造账号；该错邮箱还会被这次注册**占用**，纠错要改 env 后重新引导，上游的旧账号需人工清理。**移除条件**：上游提供按邮箱删除用户的接口，或部署改为「人工建号 + 关注册」。
2. **「账号存在但凭据不符」与「刚建号就登不上」在 `reason` 上不可区分**：两者都是 `session_unavailable`，差异只落在错误文案（`platform-account-bootstrap.ts:206-209`）。**影响范围**：只看原因枚举的监控分不出来；排障要靠同一次引导的日志流（前面的注册结果 `info`/`warn` + 随后的登录失败 `warn`）。**移除条件**：把「本次引导是否建了号」提成独立原因枚举值（需同批改文档与监控口径）。
3. **并发注册的败者以 HTTP 500 兜底**：跨副本真正同时首启时，后插入者撞 `user.uniq_email` → `HTTP 500 {code:500}` → 我方归为 `failed`（`platform-account-registration.ts:103`），与我方其它 500 在上游响应层面不可区分。**影响范围**：无功能故障——账号已由赢家建出，随后的登录照常成功，引导不失败，只多一条 `warn`。**移除条件**：上游对唯一索引冲突返回可识别业务码。**未验证**：该形态没有自动化用例（现有并发用例只覆盖同进程幂等 + 登录单飞）。
4. **`--rerun-each` 下测试夹具的端口 churn 是模块共性问题**：假上游按轮重建 `Bun.serve` 时可能复用刚释放的临时端口，与进程内 fetch 连接池里指向已停止服务的 keep-alive 连接冲突，表现为整轮用例假失败。本轮只在 `platform-account-registration.test.ts` 加固（进程级单例假上游 + 每轮重装处理器），`org-app-binding.test.ts` 等其它假上游用例文件未同步加固。**移除条件**：把该加固模式推广到其余用例文件（或统一抽成测试工具）。
5. **`workflow_v2_platform_account.last_login_at` 实际表示「最近一次供给时间」，不是「最近一次登录时间」**。该列**只有** `bootstrapPlatformAccount()` 会写（`platform-account-bootstrap.ts:292` 的 upsert），而它被 `ensurePlatformAccount()` 守卫成「台账无行时才跑一次」（`platform-account-bootstrap.ts:326-329`）；此后的**懒登录**——进程冷启动后首次业务调用触发、走 `upstream-session.ts` 的 `login()`——只写会话存储（Redis / 进程内），**不回写该列**。实测（2026-09-30 复跑 1J）：服务端日志已记录 `[wf-v2-upstream-session] 上游平台账号登录成功`，而该列的值仍是上一次引导时的时间戳。注意它与 HTTP 面的 `lastLoginAt` **不是同一个来源**：`GET /web/workflow-v2/platform-account` 回的是**进程内会话**的 `loggedInAt`（`platform-account.ts:98` ← `upstream-session.ts:580`，接口描述已写明「仅进程内记忆，重启后为 null」），DB 列则只在供给时写一次。**影响范围**：把该列当「最近一次登录时间」用的运维判断会系统性漏掉懒登录——按它计算「登录间隔」、或据此判断「账号是否还在被使用」时，会把一个刚从冷启动恢复、正在正常服务的实例读成「很久没有登录」，且偏差随上线时长单调增大（该列自首启后不再变化）。**移除条件**：二选一——要么让懒登录成功后回写该列（写点收敛到 `upstream-session.ts` 的登录成功分支，需评估「每次冷启动一次写库」的代价与本模块的写库预算），要么把该列的语义明确收敛为「最近一次供给时间」并另立一个真正的登录时间列（需同批改 `db/schema.ts` 的列注释、本文档与 `platform-account.ts` 的接口描述）。

## 6. 部署提醒

1. **上游明文打印会话值**：登录 handler 以 `Infof` 打印 `session_key`（`backend/api/handler/coze/passport_service.go:105`）；带业务码的错误另有 `Warn` 级日志（`backend/api/internal/httputil/error_resp.go:47`）。建议把上游日志级别收到 **warn 级（丢弃 info）**，并限制上游日志的访问范围——这是我方在「不改上游」前提下唯一能做的收口。（我方自身日志不含凭据：注册/引导的日志只带结果标签、业务码与传输类别。）
2. **注册默认开放本身就是安全姿态问题**：任何能访问上游的人都能自助建号。生产建议**建号完成后把注册关掉**（`DISABLE_USER_REGISTRATION=true`）。注意 §2.3 缺陷 1——**当前上游版本的白名单是坏的，关掉注册等于全关**，「只允许特定邮箱注册」这个中间档不存在；我方对「已建号 + 关注册」的部署照常工作（§3.3）。
3. **账号必须按「保留账号」管理**：`session_key` 按用户只存一个值，登录即覆盖（`user_impl.go:96-100`）。任何人在上游 UI 上用**同一邮箱**登录，都会覆盖该列并把我方会话踢掉（我方随后会拿到 `700012006`，触发一次重登；若对方持续在线操作，两边会互相顶键）。因此该邮箱必须登记为保留账号，禁止人工在 UI 登录。
4. **注册开放期间，邮箱即所有权**：上游没有邮箱激活环节（§2.3），谁先注册谁拥有该邮箱。若在生产短时开放注册建号，建号窗口内的邮箱抢注风险由部署方承担（建议建号在受控窗口内完成并立即关闭注册）。

## 7. 待确认清单

以下逐条**由部署方拍板**，本文不代为决定：

1. 平台上游账号由谁创建——由我方引导路径**自助注册**，还是部署方**人工建号**后再启用（后者会走「注册被禁 + 账号已存在」兼容分支）？
2. 该账号是否被正式登记为**保留账号**（禁止任何人在上游 UI 用同一邮箱登录）？由谁负责登记与执行？
3. 生产环境 `DISABLE_USER_REGISTRATION` 取什么值、在哪个时点切换（建号前开放 / 建号后关闭）？
4. 是否给运维侧上游 DB 写权限（决定 §4 方案 B 是否有可行性基础）？
5. 上游日志（含明文 `session_key`）的**日志级别与访问控制**由谁负责收口？
6. 是否评估 §4 的方案 B（静态会话键）？若评估，安全与合规由谁签字？
