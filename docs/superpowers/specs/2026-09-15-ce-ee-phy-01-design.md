# CE/EE 阶段 1：PHY-01 物理迁移设计

## 目标与范围

PHY-01 将认证、组织上下文、环境变量、DB/schema 唯一声明、请求上下文、后台宿主公共依赖及共享后端测试工具从根 `src/` 物理迁入 `apps/server/src/`。这是 CE/EE 阶段 1 的首个闭包，遵循 `docs/design/ce-ee-refactoring/ce-ee-refactoring-stage-1-plan.md` 的“搬位置，不改行为”合同。

本任务不迁移任何领域 route、service、repository、前端代码或后续业务闭包；不生成或修改数据库迁移；不改动 API、认证、权限、初始化或释放行为。

## 架构与物理归属

`apps/server/src/` 是本闭包的唯一 owner。配置与环境变量、DB client/连接池、唯一的 `schema.ts`、认证与宿主插件、组织/请求上下文，以及启动和关闭所需的公共辅助能力均迁入该目录，并尽量保留现有相对子目录结构。

根 `src/` 暂保留 PHY-03 至 PHY-09 的领域实现。这些文件只更新对基础能力的 import，引用 `apps/server` 的唯一实现；不复制实现、不保留 re-export shim，也不为了最终架构提前创建 platform facade 或资源包 schema。

`drizzle/` 中的 SQL、meta 与 journal 保持原路径、字节内容和执行顺序。Drizzle 配置、迁移运行脚本与测试只更新到新 schema 的引用路径。整个 schema 暂由 `apps/server` 持有，后续闭包按真实领域 owner 决定进一步拆分，PHY-01 不预先拆表。

## 不变量与失败处理

认证顺序保持 Cookie session、Environment Secret、better-auth API Key；active organization 的 header、query、cookie 优先级，以及 API Key 的组织恢复与成员校验保持不变。

DB 初始化、连接池配置、schema 导出、迁移 SQL/meta/journal 的内容和执行顺序保持不变。环境变量的类型、默认值、校验时机和废弃变量告警也保持不变；涉及旧 `src/env.ts` 路径的测试或说明随迁移更新，避免位置陈旧。

领域路由、service 和 repository 不改变参数、错误处理、事务边界或调用顺序，只修改基础模块 import。若真实引用图显示机械迁移会造成循环依赖或必须改变初始化顺序，停止该闭包，在未提交 review 记录中说明具体依赖和可选落点，等待范围确认；不得引入兼容层、双写或新业务逻辑。

## 实施与验证

先运行环境变量、DB schema/连接池、认证、请求 ID、组织上下文和相关启动测试，记录迁移前基线。将对应测试和共享测试工具迁入 `apps/server/src/__tests__/` 与 `apps/server/src/test-utils/`（按真实引用确定），原测试断言、mock 行为和测试意图不变。

每批移动后运行同一组专项测试与 server typecheck，并确认旧根路径的运行/import 引用为零后删除对应源文件。本闭包只产生一个 `refactor:` 提交；未暂存 review 记录保留文件映射、必做与不做项、基线及复测命令，以及任何中间检查失败的证据。

不在 PHY-01 运行或宣称通过全仓最终验收；完整 `precheck`、生产构建、镜像和端到端验收属于 PHY-10 的收口工作。

## 验收标准

1. 本闭包内的根 `src` 基础文件及其测试工具已不存在，且全仓没有对这些旧路径的运行或 import 引用。
2. `apps/server/src` 是 env、DB/schema、认证、请求/组织上下文和对应宿主公共能力的唯一实现位置。
3. Drizzle SQL、meta、journal 与数据迁移顺序没有任何内容变更，也没有生成 DDL。
4. 迁移前后专项测试验证认证顺序、组织上下文、环境变量与 DB/schema 行为一致；server typecheck 通过，或记录可复现的既有/跨闭包失败证据。
