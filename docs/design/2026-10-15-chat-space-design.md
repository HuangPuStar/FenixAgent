# Chat Space：会话列表的「分组 → 会话」树

> 日期：2026-10-15
> 状态：已落地（表 + 授权链 + 5 个端点 + 前端 API/hook + 侧栏分组树 + `chat-panel-ports` 侧的端口注入）；
> 展示层调整（同日）：分组顺序 = space 创建时间倒序（新建的在最上）+「默认」固定在列表最底；新建空间入口改为整行居中的大按钮；分组头文案升一档（`text-3xs` → `text-11`）且不再叠 70% 透明度；
> 交互调整（2026-10-16，用户要求「不要『移动到』这个按钮，用拖拽就是最好的」）：删除会话行的行内「移动到…」菜单，归属写入只剩指针拖拽一条路径，触屏与键盘暂时无法移动归属（§6.4）；
> 范围：`@fenix/agent-runtime`（表、门面、路由、web api/hook）与 `@fenix/ui-components`（侧栏树）；
> 不改 ACP 会话本体与 YJS 流式链路，也不新增宿主侧的路由装配逻辑（仅注册一条 `web` 槽路由）

## 1. 背景与目标

现状：侧栏会话列表按时间分组（`lib/session-grouping.ts` 的 `groupByRecency`：今天 / 昨天 / 更早），会话一多就无法按用途归拢。

目标：改成「space（会话分组）→ 会话」两层树，四条约束：

1. **space 是虚概念**：它只表达「哪些会话被归在一起」这一条用户偏好，不承载会话本体（会话仍由 ACP 侧持有，标识为 `ses_*`），也不产生任何会话数据。
2. **未归属的会话落「默认」分组**：该分组是查询的补集，不落库、不可重命名。
3. **归属写入只有指针拖拽一条路径**（2026-10-16 起）：行内「移动到…」菜单已删除，触屏与键盘暂时没有等效入口（决策与影响见 §6.4）。
4. **未接入 space 数据的调用方保持原时间分组**：`spaces` 未注入即走旧路径，向后兼容是结构性的而不是开关（见 §8.2）。

交付面：

| 层 | 文件 |
| --- | --- |
| 表与迁移 | `packages/agent-runtime/db/schema.ts`（`chatSpace`）、`drizzle/0034_agent-runtime-chat-space.sql` |
| 仓储 / 领域服务 / 错误 | `src/server/repositories/chat-space.ts`、`src/server/services/chat-space-service.ts`、`src/server/services/chat-space-errors.ts` |
| 门面（授权链） | `src/facades/chat-space-facade.ts` |
| 路由与协议 | `src/routes/web/chat-spaces.ts`、`src/schemas/chat-space.schema.ts` |
| 前端数据 | `web/api/chat-spaces.ts`、`web/hooks/use-chat-spaces.ts` |
| 侧栏 UI | `web/chat/shell/sidebar-session-list.tsx`、`shell/internal/space-group-section.tsx`、`space-header.tsx`、`space-session-drag.tsx`、`session-row.tsx`、`create-space-entry.tsx`、`use-space-action-runner.ts`、`lib/space-grouping.ts`、`lib/space-drop-target.ts` |

（包名前缀：后端均为 `packages/agent-runtime/`，UI 均为 `packages/ui-components/`。）

## 2. 领域模型

### 2.1 作用域是 `(instanceUid, userId)`

- **实例级**：会话由某个持久实例的 agent 侧产出（`session/list`），换实例即换会话池，跨实例聚合分组没有语义。
- **用户级而非组织级**：分组是个人偏好——同一组织的两个人面对同一实例的会话，各自的归拢方式互不相干。
- 落到表上就是两个 scope 列 `instance_uid` + `user_id`（§3），授权链按它们逐次校验（§4）。

### 2.2 一个会话至多属于一个 space

树形结构要求会话只出现在一个位置；允许多归属会让归属写入的语义（替换还是追加）与拖放结果无法收敛。三处实现依赖这条不变量：

1. `use-chat-spaces.ts` 的 `unassignSession(sessionId)` 只带会话 id，再由服务端按 scope 摘除——多归属下「该从哪一组移出」就没有唯一答案（这也是移出不按分组定位的原因，§4 口径 4）。
2. 拖到「默认」的含义是「无归属」（`resolveDropTarget` 产出 `unassign`），多归属下这个含义不成立。
3. `groupBySpace` 以「会话只被认领一次」为前提（重复 id 只算第一个认领的分组只是兜底，不是语义）。

落库侧由仓储在同一事务内保证：移入与移出都先按 id 顺序锁住本 scope 全部分组，再执行原子摘除（移入还会追加到目标行）。移出若省略锁，PostgreSQL `READ COMMITTED` 的 UPDATE 等待旧属主后只会重检该行，可能漏掉已扫描过的新属主；相同锁序同时避免反向移动的死锁。

### 2.3 「默认」不落库

- 默认 = 未被任何 space 的 `sessionIds` 认领的会话，是查询的补集，而不是一个被创建出来的实体（本包 schema 也只存显式分组）。若落库：就得为每个 `(实例, 用户)` 懒创建一行，还得用一个判别位把它与用户自建分组分开——否则它会占用唯一索引里的一个名字，并能被重命名 / 删除，这些额外状态都要维护。
- 界面上它恒为**最后一组**（**即使为空**）：它承载「在默认分组内新建会话」这一入口，不能随内容消失（`groupBySpace`）。
- 它不可重命名（`canRename: false`）：改名会让「未归属会话」的兜底语义从界面上消失。
- 它没有 space id，因此拖放的放置目标需要一个哨兵 id（`space:__default__`，见 §6.2）。

## 3. 数据模型

`chat_space`（owner：`@fenix/agent-runtime`，定义在 `packages/agent-runtime/db/schema.ts`，经 `@fenix/agent-runtime/db` 导出）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(80) PK | `space_` + 32 位 hex（`randomUUID` 去横线），与实例 uid 同风格 |
| `name` | varchar(100) not null | CHECK `char_length(btrim(name)) BETWEEN 1 AND 100` |
| `user_id` | text not null | → `user.id`，`ON DELETE cascade` |
| `instance_uid` | varchar(80) not null | → `agent_instance.id`，`ON DELETE cascade` |
| `session_ids` | jsonb not null default `[]` | ACP 会话 id 数组；元素增删一律是单条 SQL |
| `created_at` / `updated_at` | timestamptz not null default now() | `updated_at` 由写方法显式赋值 |

索引与约束：唯一索引 `idx_chat_space_scope_name (instance_uid, user_id, name)`；CHECK `chat_space_name_check`。

四个设计决定：

1. **两条外键都在库内**（`user.id`、`agent_instance.id`），不新增跨包组装期依赖（§6.1 的例外口径只给 `db/**`，本表用不到）。实例被删时分组随之级联消失，不留无主行；用户删除同理。
2. **重名由唯一索引裁决**，不做「先查后写」预检：插入走 `onConflictDoNothing`、重命名认驱动错误码 `23505`（逐层下钻 `cause`，不看文案）。预检只能换来一个必然存在的竞态窗口。
3. **用 jsonb 数组而不是第二张关联表**：省掉一张表和它自己的写路径，移动只在一个事务里做「摘除 + 追加」两条 UPDATE，读写都不需要 join。**代价是「一个会话至多属于一个 space」不能由数据库约束表达**——关联表可以用 `(instance_uid, user_id, session_id)` 唯一索引直接钉住，而数组只能由仓储同事务内的原子摘除保证。因此这条不变量写进了仓储契约（`repositories/chat-space.ts` 文件头），并由用例直接对下发的 SQL 取证。另一个事实：本地没有会话表（本包 schema 只有 `environment` / `agent_instance` / `chat_space`），关联表的 `session_id` 同样无法建外键，DB 侧换不来额外的引用完整性。
4. **只存 `user_id`，不存 `organization_id` / `environment_id`**：实例已是「环境 + 属主」的载体，组织维度经 `agent_instance.environment_id → environment` 在每次请求时校验（§4）。落一份组织或环境快照只会在实例的环境绑定变化时制造第二真相；不落库的直接后果是同一份分组不会因切换组织视图被切成两套——归属不符即 403 拒绝，不产生分裂数据。

写入细节（属于契约的一部分）：`session_ids` 的增删是单条 SQL（jsonb `-` / `||`），不做「读数组、改、写回」（并发移动下读改写会丢更新）；追加用 `jsonb_build_array` 包一层（jsonb `||` 要求两侧同为数组或对象，标量拼接会报 invalid concatenation）；「数组含某会话」用参数化 `@>` 判断，不用 `?` 操作符或字符串匹配——会话 id 是外部输入，拼进 SQL 文本会引入注入面，而字符串匹配会把 `{` `,` 等 jsonb 语法字符当普通字符比较。

## 4. API 契约

五个端点，均在控制面前缀 `/web/*` 下，响应形如 `{ success: true, data }` 或 `{ success: false, error: { code, message } }`。

| 方法 | 路径 | 请求 | 成功 `data` |
| --- | --- | --- | --- |
| GET | `/web/chat-spaces` | query `instanceUid` | `{ spaces: ChatSpaceInfo[] }` |
| POST | `/web/chat-spaces` | body `{ instanceUid, name }` | `{ space: ChatSpaceInfo }` |
| PATCH | `/web/chat-spaces/:id` | query `instanceUid` + body `{ name }` | `{ space: ChatSpaceInfo }` |
| PUT | `/web/chat-spaces/:id/sessions/:sessionId` | 路径参数 + query `instanceUid` | `{ space: ChatSpaceInfo }` |
| DELETE | `/web/chat-spaces/sessions/:sessionId` | query `instanceUid` | `{ space: ChatSpaceInfo \| null }`（`null` = 该会话本就不在任何分组） |

后四个动作的 `instanceUid` 位置不同（创建在 body，其余在 query），语义相同：它是服务端的权威作用域，分组 id 只在该实例内解析。

移出（DELETE）是唯一**不以分组定位**的动作：路径只带会话 id，摘除范围由服务端在本 scope 内决定。调用方要表达的是「这个会话不再属于任何分组」，按分组定位会逼它先反查服务端归属——本地快照滞后于在途写入时（刚移入的分组还没回到列表里），那个反查会指向旧分组，摘除落在不存在的行上（no-op 成功），用户的移出被静默丢弃。

视图 `ChatSpaceInfo`：`{ id, instanceUid, name, sessionIds, createdAt, updatedAt }`（camelCase + ISO 8601）；**不回报 `userId`**——调用方即属主，回报它只会给前端一个不该使用的字段。

错误语义（错误码与文案集中在 `src/server/services/chat-space-errors.ts`，是冻结契约的一部分）：

| 状态 | code | 触发 |
| --- | --- | --- |
| 401 | — | 无有效凭据：由宿主的认证守卫在到达路由前拦下，路由不自行解析凭据 |
| 403 | `forbidden` | 认证上下文缺 user 或 active organization；或实例绑定的环境属于别的组织 |
| 404 | `not_found` | 分组不存在、不属于当前用户，或**不落在给定 `instanceUid` 的实例下**；实例不存在 / 格式非法 / 属于别人；实例绑定环境已消失 |
| 400 | `invalid_name` | 名称 trim 后为空或超过 100 字符 |
| 400 | `invalid_session_id` | 会话 id 为空或超过 200 字符（jsonb 列不受列宽约束，这里只为拦住无界写入） |
| 409 | `name_conflict` | 同 scope 下已存在同名分组（创建或重命名，并发同样落到这里） |

口径说明：

1. **`instanceUid` 是权威作用域，五个动作都带**：创建在请求体，其余四个在 query。以分组定位的两条（PATCH / PUT）先过实例授权，再要求分组行确实落在该实例内（`(id, user_id)` 命中且 `instance_uid` 与入参一致），否则 404——**同属主跨实例不因「两边都属于他」而放行**，也不泄露「该分组存在」。移出（DELETE）同样先过实例授权，但摘除谓词是 scope +「数组含该会话」，不读分组归属。契约不放任「实例由分组行推导」：那会让调用方在不知道作用域的情况下改写一个分组。
2. **授权链两步**（`src/facades/chat-space-facade.ts`）：实例归属（`agentInstanceService.getOwnedInstance`：格式非法 / 不存在 / 属于别人合并成同一个 404，不区分成因，避免探测跨用户存在性）+ 环境组织归属（`environmentAccessFacade.resolveSessionEnvironment`：跨组织 403、环境消失 404，容忍「未挂组织」的存量环境）。非 `AppError` 异常原样上抛——存储故障不得伪装成 404。
3. **`name` 长度规则只在领域服务裁决**（协议层只声明为 string）：同一规则写两份必然漂移，协议层因此不重复加约束。
4. **移出幂等，且不按分组定位**：会话本就不在任何分组时 `space` 返回 `null`（仍 200）。摘除是单条 UPDATE，谓词限定「含该会话的行」——无关分组的 `updated_at` 不被无端推进。
5. **`PUT .../sessions/:sessionId` 的归属唯一由仓储事务保证**，路由不做补偿逻辑。
6. 错误文案不含任何内部标识：跨租户存在性不可从响应内容被探测。
7. 路由文件只做协议适配（Elysia model 校验、认证上下文提取、视图投影、`AppError.statusCode → 响应` 映射）；守卫由宿主注入，包内不自建一份（Elysia 的 `macro` / `state` 是实例作用域的）。

8. **`create_session` 的 committed Ack 携带创建回执**：`committed Ack` 等到 Agent 的 `session/new` 结果再发，`sessionId` 即本次创建出的会话；Ack 只回发起该命令的连接（`sessionId` 与 `turnId` 同为 `CommandOutcome` 的可选补充字段，帧类型不变）。Agent 拒绝、超时、relay 断开时仍发 committed、但不带 `sessionId`——「没有回执」与「创建成功」在协议上可区分。

## 5. 前端数据流

会话列表与归属是**两个独立来源，在渲染时合并**：

1. 会话列表来自 YJS 投影：`chatState.sessions`（Session Doc 的 `sessions` 投影位，由 agent 侧 `session/list` 轮询全量同步，响应中不存在的条目被删除）。时间分组此前也消费它（`use-acp-session-bootstrap.ts`）。
2. 归属来自 DB：`GET /web/chat-spaces?instanceUid=`，经 `web/api/chat-spaces.ts`（`@fenix/agent-runtime/web/api/chat-spaces`）与 `web/hooks/use-chat-spaces.ts`。
3. 合并点是 `groupBySpace(sessions, spaces, 默认文案)`：DB 归属决定「谁在哪个分组」，YJS 会话决定「有哪些会话、标题与时间」。任一侧缺失都不影响另一侧渲染——这也是归属残留与列表自愈能各自独立成立的前提（§7 第 1 条）。

`groupBySpace` 的归并规则（`lib/space-grouping.ts`，纯函数）：

- 组顺序 = 宿主数组顺序 + 「默认」固定在最底；空 space 保留（分组是容器，折叠状态与新建入口都依赖它存在）。
- 宿主数组顺序来自 `GET /web/chat-spaces`（`listByScope` 口径，见 §7 第 5 条）：`created_at desc, id desc`，因此**最近新建的 space 排在最上面**，默认分组是兜底容器、恒定垫底。
- `sessionIds` 里已不存在的会话 id **忽略**，不制造幽灵行；同一 space 内重复 id 只算一次；跨 space 重复归属按数组顺序取第一个认领者。
- 组内按 `updatedAt` 降序，与时间分组共用 `sortByRecencyDesc`（一条「最近优先」语义只有一个实现）。

`use-chat-spaces.ts` 的语义（消费方按这八条接线）：

- `instanceUid` 为空即「还没有实例可谈」：不发请求，`spaces=[]` 且 `spacesLoaded=false`。调用方据此区分「尚未加载」与「已加载但确实没有分组」——与列表侧 `sessionListLoaded` 同一思路。
- 四个变更动作都把当前 `instanceUid` 一并发出（服务端的权威作用域）；实例未就绪时直接抛错（英文开发者文案，会经提示槽位透出，写中文会在英文界面下露出半截中文）而不是发一个作用域不明的请求。
- 数据连同它所属的实例 uid 一起存放，并 `refreshDeps: [uid]`：切实例的瞬间 `data` 里还是上一个实例的结果，直接透出会把 A 实例的分组画到 B 实例上（ahooks 用请求序号丢弃被取代的旧响应）。
- 变更成功后 `refresh()` 重取，**不做本地合并**：同一 hook 内、同实例的变更按发起顺序串行发送（失败不阻断后续写，不同实例互不阻塞），避免网络乱序反转最后一次移动；跨标签页顺序由数据库锁获得顺序决定。重取不阻塞调用方，迟到旧 GET 由 ahooks 请求序号丢弃。
- **列表失败经 `spacesError` 透出**（`console.error` 保留诊断上下文），并配 `refreshSpaces()` 重试入口；失败态连同所属实例 uid 一起存，A 实例的失败不跟着切到 B。失败**不得静默成「没有分组」**，也不得停在永久 loading。
- **变更失败**经 `unwrap` 归一成 `ApiError` 后原样抛出，由侧栏提示并回退乐观状态。
- `unassignSession(sessionId)` 只带会话 id，**不做本地反查**：摘除范围由服务端按 scope 决定（§4 口径 4）。反查版会被滞后快照骗到旧分组，摘除落在空行上、用户的移出被静默丢弃。
- 列表之外的写入动作（创建 / 重命名 / 移入 / 移出）成功后一律重取，失败不重取——本地不制造等价写。
- 列表顺序即**展示顺序**（不另做本地排序）：新建的分组经重取自然出现在最上面，`groupBySpace` 只把默认分组固定到最底（§5 归并规则）。

出口边界：`lib/space-grouping.ts` 经 `@fenix/ui-components` 根出口暴露；`lib/space-drop-target.ts` 是包内实现细节，**不进 exports**（拖放决策不是宿主职责，扩大出口只会让宿主以为自己该接一层）。

宿主接线状态（事实）：`ACPMain` / `SidebarSessionList` / 移动端抽屉的 `spaces`、`spacesLoaded`、`spacesError` 与五个回调端口（含 `onRefreshSpaces`）已就位，且 `packages/agent-runtime/web/agent-panel/`（`chat-panel-ports.tsx` 经 `useChatPanelPorts`）已把八项接上——数据层 `web/api/chat-spaces.ts` + `web/hooks/use-chat-spaces.ts` 与后端路由同在本包，不经宿主注入。两点接线口径：`instanceUid` 取**持久实例 uid**（`ACPMain` 的 `detailSessionId`，不是 ACP session id）；实例未选中时整组端口都不注入（`spaces` 传 `undefined` 而不是空数组），侧栏因此退化为时间分组、hook 也不发请求。

## 6. 交互

### 6.1 分组树与折叠

- 一组一个 `SpaceGroupSection`，折叠用 `Collapsible`（默认展开）。折叠状态是**纯展示态**：组件自持，不随宿主刷新消失，也不进宿主数据。
- 整组（含折叠后的组头）都是放置目标：否则「先折叠再拖」会得到「拖哪儿都没反应」。悬停高亮取 `useDroppable` 的 `isOver`（只在拖拽期间为真，静止的侧栏不因拖动而重渲染），另给一份 `sr-only` 的「放置到这里」文本——颜色变化对读屏不可见。
- 空分组保留一行占位；会话总数为零且加载完成时仍渲染整棵分组树与新建入口。
- 组头动作在悬浮、组内焦点与粗指针下可见；折叠按钮的无障碍名称含分组名。新建与重命名自动聚焦输入、关闭后恢复焦点，取消不因 blur 提交，输入法组合期间 Enter 不提交。
- 组头（`SpaceHeader`）：折叠触发 + 名称 + 悬浮操作（重命名 / 组内新建）；默认分组不可重命名，只保留组内新建。分组名用 `text-11` 档（`text-3xs` 的相邻档）与满不透明的 `text-text-muted`：默认分组与真实分组共用同一个组件、同一档文案，避免同一个列表里出现两种分组头样式。重命名输入用非受控 `ref` 只在提交时取值（受控会让每次按键重渲染整个侧栏），空名与未改名都不提交。
- 新建入口（`create-space-entry.tsx`）只发起 `onCreateSpace`，提交后立即收起——输入框不保留草稿，避免与宿主刷新回来的数据形成两份「待创建」状态。收起态是**整行宽度、内容居中的描边按钮**（`size="sm"` + `w-full`，比原先的小胶囊更大也更好点），入口位置仍在分组列表上方；展开态的内联输入与聚焦 / 触屏行为不变。桌面侧栏与移动端抽屉各渲染一份，因此两侧各有一处入口。

### 6.2 拖拽归入（指针）

- **只用 `PointerSensor` + `activationConstraint.distance = 5`**：会话行既是点击目标（切换会话）又是拖拽源，没有阈值时按下即进入拖拽、点击再也选不中会话；阈值太大则「拖了一点却没反应」。
- 落点判定用 `pointerWithin`：用户看到的是「指针压在哪一组上」，矩形相交会在分组边界附近选到视觉上并未悬停的邻居。
- **不设 `touch-action: none`**：移动端抽屉里的列表必须能滚动，触屏拖动会被浏览器判为滚动并以 `pointercancel` 中止——这是预期行为。菜单删除后同一取舍的代价变得可见：**触屏无法移动会话归属**（§6.4）。
- **不做键盘拖拽**：会话行是复合控件（标题按钮 + 动作按钮），把 `role="button"` 挂到整行会破坏它自身的语义；dnd-kit 的键盘传感器还要求拖拽源可聚焦并被读屏正确播报——本层没有键盘路径，**键盘用户无法移动会话归属**（§6.4）。
- 不引 `@dnd-kit/sortable`，组内顺序由「最近优先」决定。
- 放置目标 id：默认分组用哨兵 `space:__default__`（刻意远离 nanoid / uuid 形状——真实 id 若与之相同，两个放置目标会撞成一个 id，dnd-kit 只认其中一个、静默丢掉落点），真实分组为 `space:<id>`。
- 落点判定按分组 id 匹配（`resolveDropTarget`），**与分组渲染顺序无关**：默认分组移到列表最底后，拖到默认分组仍等价于移出归属（`unassign`），拖到自身所在分组仍是不写。

### 6.3 乐观更新

- `commitAssignment`：写入发起时置位覆盖表（`Map<sessionId, spaceId | null>`）并记录本次版本；迟到失败只撤回相同版本，不能抹掉随后移动的覆盖。写仍在途时不允许相等快照退场（A→B→A 的旧 A 不等于最后一次写已落库），落定后再重检快照。
- 覆盖表**叠加**到宿主快照而不是替换（`applyAssignmentOverrides`）：只改写被拖动过的会话，其余分组与顺序仍以宿主为准；同一个会话先摘除再落到新组，两次改写在一处完成，界面因此不会出现「同时属于两个分组」的中间态。
- 覆盖**靠快照追上来退场**（`pruneSettledOverrides`），不靠「写入成功」：写入成功到重取返回之间有真实时间差（重取是 fire-and-forget），此时撤掉覆盖会让会话先跳回旧分组再跳回来。反过来，重取长期失败时覆盖一直挂着，表现为「本地记住用户最后一次移动」——比闪回旧状态更接近事实，代价是该会话在宿主数据修好前不再跟随远端变化。
- 拖到当前所属分组（含「默认 → 默认」）不改任何东西：写进去只会得到同一份归属，却要多一次请求与一次往返（`resolveDropTarget` 返回 null）。落点为空或不在已渲染分组里同样不改。
- 归属写入的入口按目标二选一（`null` → `onUnassignSession`，否则 `onAssignSession`）；对应回调未注入时**什么都不做**——画出一个永远不会落库的归属比不做任何事更糟。

### 6.4 「移动到…」菜单：已于 2026-10-16 删除（无障碍 / 触屏路径的移除）

**决策（2026-10-16，用户要求）**：行内「移动到…」菜单（`session-row-move-menu.tsx`）与它的装配（`SessionMoveTarget` 类型、`moveTargets` / `currentSpaceId` props、`SessionRowActions.onMoveToSpace`、侧栏的目标列表与 i18n 键 `chat.components.acpMain.moveToSpace`）整条删除，**归属写入的唯一路径是指针拖拽**（5px 激活阈值，见 §6.2）。

**这不是一次纯清理，代价必须记住**：菜单原本是这条写入路径的等效入口，覆盖拖拽覆盖不到的两类用户——

- **触屏**：本包刻意不给会话行设 `touch-action: none`（否则移动端抽屉的列表滚不动），触屏拖动会被浏览器判为滚动并以 `pointercancel` 中止，**移动端抽屉里无法移动会话归属**；
- **键盘 / 读屏**：会话行是复合控件，键盘传感器需要把它标成可聚焦的拖拽源，因此**键盘用户无法移动会话归属**。

其余受影响的面：会话行操作条仍保留「悬浮 / 行内焦点 / 粗指针」三态可见（触屏要能重命名与删除），只是不再有归属入口；`chat.components.acpMain.moveToSpaceFailed` 仍在使用（拖放失败提示），只有菜单标题键被删；demo 文案已同步为「归属只能靠指针拖拽写入」。

**移除条件（恢复触屏 / 键盘路径的前提）**：重新引入一条覆盖这两类用户的等效入口——例如键盘可聚焦的「移动到分组」动作（先解决它与行内标题 / 动作按钮的语义冲突），或触屏下不牺牲列表滚动的长按拖拽。届时须同步回本节的取舍说明与 `space-session-drag.tsx` 的文件头，并把对应用例补回 §8.1 的侧栏交互行。

### 6.5 分组内新建会话：绑定创建回执

- 点组头「+」→ `ChatInterfaceHandle.newSession()` → resolve 为**本次创建回执**（Agent 实际创建出的 `ses_*`）→ 仅凭该 id 写归属；默认分组（`null`）只创建、不写归属。
- 回执由服务端按 `commandId` 定向回给发起连接（`action_ack.sessionId`，见 §4 口径 8），因此「本页本次创建出了哪个会话」有确定答案。
- **不得用 `onSessionCreated`（共享投影的 active session 变化）推断创建结果**：同一 Y.Doc 上别的标签页创建/切换会话同样会改它，据此写归属会把别页会话算进本页点过的分组（第二轮 Y8）。
- 回执为 `null`/`undefined` 一律不写归属：忙碌被拒（`ChatInterface` 只提示）、发送失败、Agent 拒绝、超时（服务端等待 Agent 上限 10s，客户端 15s）与断连都走这一条。
- 用户中途切走或再建其它会话不影响绑定：每次点击各带自己的 `commandId`，回执迟到也只会落到它自己那次创建上。
- `ChatInterfaceHandle.newSession` 的返回值为增量字段：宿主未升级时仍可返回 `void`（`SessionCreateReceipt` 含 `void`），此时组内新建只是不落归属，不影响建会话本身。
- 删除动作发送不代表 ACP 删除成功：仅当非加载态的会话列表确认该 id 消失后，才调 `onUnassignSession` 清理；会话仍在列表时保留归属，元数据清理失败提示但不回滚 ACP 删除。

### 6.6 失败出口统一

`use-space-action-runner.ts` 把两条失败路径（回调同步 throw / 返回 rejected promise）收敛到一处，提示与（乐观写的）回退**同源**，避免「提示了但没回退」或反过来。space 数据的权威在宿主：本包只发起写、不持有副本，失败只提示，列表随下一次宿主快照收敛。

## 7. 已知取舍与风险

1. **归属残留**：agent 侧删除会话后，DB 的 `chat_space.session_ids` 不会同步（平台不感知 ACP 的会话生命周期）。前端按「忽略未知 id」处理（`groupBySpace`），因此残留项不渲染幽灵行，只体现为 jsonb 体积。不做后台清理的理由：清理需要跨模块回查 ACP 会话，收益低于引入该依赖；**移除条件**：出现可复用的会话回查能力，或真实数据上残留量明显。
   注意区分两侧：YJS 的 `sessions` 投影由 `session/list` 轮询自愈（响应中不存在的条目被删除），自愈的只是列表，不是 DB 归属。
2. **多标签页不同步**：乐观覆盖与列表都由「本标签页重取」驱动，后端没有归属变更的推送；另一标签页要等自己的下一次重取（切换实例或发起变更）才看到。影响是同一用户在两个标签页看到不同的归属，不产生数据损坏。
3. **本期不做 space 删除**（没有 `DELETE /web/chat-spaces/:id`）。未来若加，口径应为「**仅空 space 可删**」：删除非空分组要么静默把其中的会话退回默认（丢弃用户意图），要么级联改归属，两者都是额外语义。
4. **不做后台清理任务**：空 space 长期保留（它是容器，用户可能继续放入会话）；用户与实例删除已由外键级联覆盖，真正的无主行不需要巡检。
5. **分组顺序不可自定义**：展示顺序即后端返回顺序（`created_at desc, id desc`——最近新建的在最上，同毫秒创建也要有稳定顺序，否则刷新后列表跳动），且「默认」由 `groupBySpace` 固定在最后一组（它不落库，顺序只在前端决定）。拖拽只改会话归属，不重排分组。

6. **创建回执的等待上限**：服务端为 `create_session` 等 Agent 的 `session/new` 结果最多 10s（`waitForSessionCreation`），超时/relay 断开/Agent 拒绝都以「无回执」提交；客户端 15s 未收到 committed Ack 同样按无回执处理。后果是这些路径下用户的「在该分组新建」不落归属（会话本身仍已创建或已失败，界面对应提示由既有失败出口给出）。**移除条件**：出现可靠的创建结果重放（如按 commandId 查询创建结果），或把创建失败升级为 `action_error` 后。

## 8. 验证与回滚

### 8.1 验证

| 范围 | 用例 |
| --- | --- |
| 路由协议面 | `packages/agent-runtime/src/__tests__/chat-space-routes.test.ts`：未认证 401、缺组织上下文 403、跨用户 404、跨组织 403、**分组不落在给定 `instanceUid` 实例下 404 且零写入**、视图字段集（`SPACE_VIEW_KEYS` 钉住六个键）、请求体或查询串夹带 `userId` 不能改变实际归属、重名 409、**移出按 scope 摘除且幂等**（单条无分组 id 谓词的 UPDATE，未命中返回 `space: null`） |
| 仓储与领域服务 | `packages/agent-runtime/src/server/__tests__/chat-space-repository.test.ts`：直接对下发的 SQL 取证（摘除是单条无 id 谓词的 UPDATE、追加是 `jsonb_build_array` 拼接、每条语句都带 `user_id` 与 `instance_uid`、**列表按 `created_at desc, id desc` 下发**），另覆盖命名规则、`23505` 与其它驱动错误的分流、移出未命中返回 `undefined`（幂等成功，不是 404） |
| 前端 API / hook | `packages/agent-runtime/web/__tests__/chat-spaces-api.test.ts`（五个方法的路径、query 与键名归一、失败信封归一成 `ApiError`）、`web/__tests__/use-chat-spaces-hook.test.tsx`（未就绪不发请求、切换实例不短暂透出旧数据、变更失败抛出且不重取、成功后重取、**移出无条件发 DELETE 不按本地快照反查**、列表失败经 `spacesError` 透出且重取成功后清空、失败态不跨实例继承、实例未就绪时变更动作抛错且不发请求） |
| 宿主端口接线 | `packages/agent-runtime/web/__tests__/chat-panel-space-ports.test.tsx`：`instanceUid` 取持久实例 uid、实例未选中时整组端口全不注入且不发请求、列表未到达前不把空数组当「已接入」、切换实例重取、**连续两次归属写不依赖滞后快照**、**列表失败经 `spacesError` 透出且可重试**、写失败原样抛出 |
| 侧栏交互 | `packages/ui-components/web/__tests__/sidebar-session-list-space-groups.test.tsx`（分组渲染与折叠、重命名回调、删除后清归属、拖拽源与放置目标装配及**渲染顺序（space 在前、默认垫底）**、**拖拽落点写入归属（乐观重排 / 拖到默认即移出 / 松手在分组外不写 / 写失败回退并提示 / 宿主未接回调时静默）**、未注入 spaces 退化为时间分组、`spacesLoaded=false` 保持 loading、**加载失败时错误态可重试 / 有会话时不接管列表**）、`space-grouping-pure.test.ts`（归属边界 + **顺序契约：space 按宿主数组顺序、最新在最先、默认垫底**）、`space-drop-target-pure.test.ts`（落点语义与乐观覆盖，含**默认分组换位后落点判定不变**）、`chat-space-review-regressions.test.tsx`（**顺序与入口位置：多 space 时最新的在最上、默认固定在列表最底、新建空间入口在分组列表上方**） |
| 组内新建意图 | `packages/ui-components/web/__tests__/acp-main-space-intent.test.tsx`：新会话回传即写入归属、忙碌被拒不留意图（后续会话切换不得写出归属）、用户切换会话放弃未消费意图 |

| 创建回执（Y8） | `packages/chat-channel/src/__tests__/session-create-receipt.test.ts`（committed Ack 等 Agent 结果并携带 session id、被取代的迟到回执仍结算、Agent 拒绝与 relay 断开以空回执提交）、`packages/agent-runtime/web/__tests__/create-session-receipt.test.tsx`（`onCreateSession()` 按本次 commandId 结算、accepted 不结算、其它标签页的 commandId 不结算、失败帧结算为空）、`packages/ui-components/web/__tests__/acp-main-space-intent.test.tsx`（回执落归属、回执在途时别页会话变化零归属、两页同时创建只归本页回执、迟到回执、忙碌/空回执零归属、默认分组不写归属） |
| 第二轮并发与生命周期回归 | `chat-space-repository.test.ts`：移入/移出相同事务锁序；`use-chat-spaces-hook.test.tsx`：写串行、失败不堵队列、跨实例并行、旧 refresh 不覆盖新快照；`space-drop-target-pure.test.ts`：在途 A→B→A 不提前退场；`chat-space-review-regressions.test.tsx`：空会话入口、取消/焦点/输入法、迟到失败；`acp-main-space-intent.test.tsx`：回调换引用、异步创建失败；`sidebar-session-list-space-groups.test.tsx`：列表确认删除才清理归属 |

命令：迭代期 `bun run fastcheck`；提交前 `bun run precheck`；本批改过 schema，另跑 `bun run check:schema-ddl-drift` 与 `bun run db:migrate`；前端改动按规范补 `bun run build:web`。第二轮只改事务与前端内部实现，未改 DDL、协议响应或跨包签名，不需新增迁移。

注：`sidebar-session-list-space-groups.test.tsx` 依赖 Radix 在模块求值期读到的全局 `document`，**必须带 `--isolate`**（`precheck` / `fastcheck` 已带该开关）。
注（2026-10-16，菜单删除后）：拖拽是归属写入的唯一路径，落库断言因此必须真的走一遍指针链路。`web/__tests__/space-drag-harness.ts` 补齐 happy-dom 恒为 0 的布局矩形，再用 `pointerdown → pointermove ×2 → pointerup` 驱动 dnd-kit 的 PointerSensor（第一次移动只越过 5px 激活阈值，第二次才产生落点）；它依赖 dnd-kit 的激活时序，升级 `@dnd-kit/core` 后若用例变红，先核对该版本的 `AbstractPointerSensor.handleMove` 与碰撞回调入参。踩过的坑：写入 promise 的 `finally` 会让 React 打出「not wrapped in act」，因此松手事件与随后的微任务、定时器必须在**同一个** `act` 内结算。

### 8.2 回滚

1. **数据层**：本批迁移只新增一张表（`drizzle/0034_agent-runtime-chat-space.sql`），**无存量数据搬迁或回填**，因此回滚为 `DROP TABLE "chat_space"` 并同步回退同批 `drizzle/meta` 记录；其它表不受影响。
2. **应用层**：端点与侧栏接线可整批回退。分组数据与会话本体无耦合（会话由 ACP 侧持有），删表不会丢会话，只是归属信息消失。
3. **前端**：`spaces === undefined`（未注入）即走原时间分组路径，列表代码本身无需回退；宿主不注入 `spaces` 就已经是旧形态——这也是本功能天然的灰度与降级开关。
