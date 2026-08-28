# C1 · 包合并与引用迁移（prefactor）

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（Q1/Q1b/Q2/Q2b/Q11/Q14）
> 性质：基础设施切片，行为零变化

## What to build

建立 Chat 域独立包 `packages/chat-channel`，将原 `@fenix/acp-server` 的全部能力原样迁入（**逻辑零改动**），删除原包并迁移所有引用，作为后续所有重构切片的地基。

具体内容：

1. **建包**：`packages/chat-channel/`（package.json 名称 `@fenix/chat-channel`，含 `"test": "bun test"`），目录结构：
   - `src/channel/`（控制面，本次仅占位入口，后续 C3/C6 填充）
   - `src/protocol/`（原 acp-server 的 protocol/ 迁入：translator、config-options 等）
   - `src/state/`（原 acp-server 的 state/ 迁入：aggregator、doc-manager、chat-writer、factory、yjs-store，逻辑不动）
   - `src/persist/`（原 acp-server 的 persist/ 迁入：redis provider）
   - `src/types.ts`（原 types.ts 迁入）
   - `src/index.ts`（保留原 acp-server 的全部导出面：`applyACPEvent`、`DocManager`、`createChatDoc`/`loadChatDoc`/`createSessionDoc`/`loadSessionDoc`、`createYjsStore`、`translateSimpleAction`、`translateSimpleAction` 相关等）
2. **注册 workspace**：根 `package.json` workspaces 加入新包；`bun.lock` 同步。
3. **删除原包**：`packages/acp-server/` 目录移除（含 README、测试），**不留兼容壳**。
4. **引用迁移**：仓库内所有 `@fenix/acp-server` import（约 15-20 处：`src/`、`web/`、`packages/` 其他包、`src/__tests__/`、文档中的包名引用）一次性改为 `@fenix/chat-channel`；原 acp-server 的测试文件随包迁入 `packages/chat-channel/src/**/*.test.ts`（路径保持相对结构）。
5. **注册到根 package.json scripts**（如 precheck 的测试范围需要包含新包，参照 orchestration 包的做法）。

**不做**：不重构任何逻辑、不新建控制面实现、不迁移 `src/transport/relay/yjs-frontend/`（该目录 C3/C6 处理）、不删除 `web/src/acp/`（C2 处理）。

## Acceptance criteria

- [ ] `packages/chat-channel` 建成，`@fenix/acp-server` 从 workspaces 与 `bun.lock` 中移除，仓库内 grep 不到 `@fenix/acp-server` 残留引用
- [ ] 原 acp-server 的全部导出面在 `@fenix/chat-channel` 下可用，`index.ts` 导出与原包完全对齐（可 grep 对比导出列表）
- [ ] 迁入的测试（原 acp-server 测试）在包内全绿（`cd packages/chat-channel && bun test`）
- [ ] `bun run precheck` 全绿；`bun run build:web` 通过；`bun run check:deps` 无新告警
- [ ] `docs/arch/changes.md` 已记录包合并

## Blocked by

None - can start immediately
