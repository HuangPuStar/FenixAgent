# 文件区大小与修改时间实现计划

**目标：** 按已确认原型的双行方案，在文件名下展示大小、修改时间，并通过悬停或键盘聚焦查看完整信息。

**架构：** 复用 `acp-link → machine → FileTreeTab → ui-components` 文件链路。在现有树快照增加可选 `sizes` 路径映射，与 `mtimes` 一起传递；元数据来自已有 stat，不新增逐文件请求或数据库字段。沿用环境鉴权、黑名单过滤、文件事件与条件重取。

**技术栈：** Bun、React、react-arborist、Radix Tooltip、Intl、现有 i18n 与 Tailwind。

## 已确认设计

1. 文件使用双行：首行文件名，次行 `24.6 KB · 2 分钟前`；目录保留单行，不显示递归统计大小。
2. 悬停或键盘聚焦显示完整文件名、精确字节数和本地时区的修改日期时间。
3. 零字节为 `0 B`；旧机器端或 stat 失败的缺失元数据显示 `—`，不伪造为零字节或当前时间。
4. 上传、写入、重命名后的重取同时更新元数据；失败保留上一份文件树。元数据参与 ETag，避免 304 保留旧信息。
5. 不加入原型的方案比较器、栏宽调试控件，也不新增分栏模式。沿用现有文件栏拖动宽度、搜索与行内操作。
6. `acp-runtime-cli` 通过现有打包带入新版 `acp-link`，无需修改 `agent-runtime` 装配逻辑；旧部署需更新机器端 runtime 才能获得大小。

## 任务 1：本地与机器端树元数据

**文件：** `packages/acp-link/src/client/file-operations.ts`、`packages/resources/machine/src/server/services/{workspace-fs,file-backends,file-types,remote-file-service}.ts`、`packages/resources/machine/src/schemas/file.schema.ts`、`packages/resources/machine/src/server/routes/web/fs.ts`。

- [x] 在 `file-operations.test.ts`、`agent-file-service.test.ts`、`fs-etag.test.ts` 先添加真实文件和远程传输边界回归，运行并确认因缺失大小与指纹变化而失败。

```ts
expect(tree.sizes?.["user/empty.txt"]).toBe(0);
expect(tree.sizes?.["user/data.txt"]).toBe(6);
expect(computeTreeFingerprint(["a"], { a: 1 }, { a: 1 }))
  .not.toBe(computeTreeFingerprint(["a"], { a: 1 }, { a: 2 }));
```

- [x] 同次 `lstat` 采集大小与时间，不跟随 symbolic link；目录、链接与失败项不填大小。新增可选 `sizes`，远程适配器按可见路径过滤后返回。
- [x] 指纹计算包含每条可见路径的修改时间与大小，而非仅最大时间；schema 注明字节单位与缺失语义。
- [x] 运行 `bun test packages/acp-link/src/__tests__/file-operations.test.ts packages/resources/machine/src/server/__tests__/agent-file-service.test.ts packages/resources/machine/src/server/__tests__/fs-etag.test.ts`，预期全部通过。

## 任务 2：前端模型与文件行

**文件：** machine 的 `web/api/fs.ts`、`web/hooks/use-file-tree-events.ts`、`web/components/FileTreeTab.tsx`；ui-components 的 `file-tree-model.ts`、`file-tree-arborist.tsx`、`lib/format.ts` 和中英字典。

- [x] 先添加元数据经过建树、分区、搜索保留的测试，以及零值、缺失与相对时间展示测试。

```ts
const nodes = parsePathsToTree(["user/empty.txt"], { "user/empty.txt": 1 }, { "user/empty.txt": 0 });
expect(findFileNode(nodes, "user/empty.txt")).toMatchObject({ size: 0, modifiedAt: 1 });
```

- [x] 首次取树与条件重取都传递 `sizes`；视图节点在边界转换为可选 `size/modifiedAt`。
- [x] 复用文件大小和日期格式化能力，双行布局统一虚拟行高并同步 sticky 行索引。统一 Tooltip 处理完整信息，不让悬停操作遮挡第二行。
- [x] 中英文文案通过 `t()`；相对时间随组件生命周期更新并清理定时器。
- [x] 运行相关模型与视图测试，预期零字节、旧机器缺失字段、搜索和更新行为全部通过。

## 任务 3：验证与稳定契约

**文件：** `docs/arch/12-files.md`；受影响测试。

- [x] 记录树快照的 `sizes/mtimes`、缺失语义和 ETag 契约。
- [x] 运行 `bun run fastcheck`、`bun run build:web`、`bun run precheck`，检查完整日志；全量门禁的自动修复仅允许触及已审查范围。
- [x] 编译本机机器端包：`bun run build:machine-runtime --platform darwin-arm64`，确认 acp-link 更新进入 runtime。
- [x] 浏览器检查真实文件行在 184px 栏宽、展开目录、零字节、长文件名、悬停和键盘聚焦下的行为。

**回滚：** 回退本次前后端代码；新增字段可选，旧前端忽略它们，旧机器端缺失字段时前端明确显示未知。

## 验证范围

1. 在独立 worktree `.worktrees/file-tree-metadata`、分支 `feat/file-tree-metadata` 实现，未合并主工作区。
2. 使用与 CI 一致的 Bun 1.4.3，门禁覆盖 `precheck` 的静态检查、包测试、服务端与脚本测试及前端测试。
3. 构建验证覆盖 `fastcheck --no-tests`、前端生产构建和 darwin-arm64 机器端 runtime 构建。
4. 真实浏览器检查窄栏、零字节、未知大小、搜索、目录折叠、悬停，以及 Tab / 方向键查看完整信息与 Escape 关闭；键盘路径和外部 symlink 边界均有回归测试及修复前失败证据。
