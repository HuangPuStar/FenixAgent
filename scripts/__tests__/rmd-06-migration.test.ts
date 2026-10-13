import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

/**
 * RMD-06 物理迁移台账：12 个获批的根目录源码文件迁出 `apps/server/src` / `apps/web/src`。
 *
 * 元素为 `[旧根路径, RMD-06 当时的 owner 目标, CE 阶段 2 任务 1.2 之后的当前落点]`。
 * 第三项为 `null` 表示该文件在 1.2 被删除（均无消费者），此时 RMD-06 目标也必须不存在；
 * 与 RMD-06 目标不同的第三项表示 1.2 再次搬迁，此时 RMD-06 的中间落点不得残留。
 *
 * 1.2 的落点变更：
 * - `control.ts` 在 1.2 暂落宿主 `apps/server/src/routes/web/control.ts`——当时的理由是它同时依赖
 *   Agent Runtime 的会话服务与 Machine 的事件服务，放进任一模块都会与既有的 `resource-machine →
 *   agent-runtime` 形成环（原计划为迁入 agent-runtime，实施时因依赖方向冲突改判）；1.5c 按 §四
 *   分片表改判回 `packages/agent-runtime/src/routes/web/control.ts`：1.4 W6b 已把 EventBus 与
 *   `environmentRepo` 收敛回 agent-runtime（Machine 的同名薄封装删除），上述环的构成前提随之消失。
 * - `user.ts` / `ChangePasswordDialog.tsx` 随身份职责整体迁入 `packages/platform/identity`。
 * - `share-link.ts` / `token.ts` 与 2 个 token 前端测试删除：前者只有自身的 barrel 导出、
 *   无任何调用方（分享表保留在宿主 schema，删除推迟到 1.7），后者是遗留内存 token 实现。
 * - 旧授权栈的仓储、协议 schema 与 3 个专项测试随 `resource_permission` 权限栈在 1.2 一并删除：
 *   新授权栈把归属收敛到资源主表的 `organization_id` + `visibility` 列，这些文件失去全部消费者。
 */
const RMD_06_MOVES = [
  [
    "src/repositories/resource-permission.ts",
    "packages/platform/access-control/src/repositories/resource-permission.ts",
    null,
  ],
  [
    "src/schemas/resource-access.schema.ts",
    "packages/platform/access-control/src/schemas/resource-access.schema.ts",
    null,
  ],
  [
    "src/__tests__/resource-permission-service.test.ts",
    "packages/platform/access-control/src/__tests__/resource-permission-service.test.ts",
    null,
  ],
  [
    "src/__tests__/round23-resource-permission-isolation.test.ts",
    "packages/platform/access-control/src/__tests__/round23-resource-permission-isolation.test.ts",
    null,
  ],
  [
    "src/__tests__/round64-resource-permission-repository.test.ts",
    "packages/platform/access-control/src/__tests__/round64-resource-permission-repository.test.ts",
    null,
  ],
  [
    "src/routes/web/control.ts",
    "packages/resources/identity-admin/src/routes/web/control.ts",
    "packages/agent-runtime/src/routes/web/control.ts",
  ],
  ["src/repositories/share-link.ts", "packages/resources/identity-admin/src/repositories/share-link.ts", null],
  ["src/repositories/token.ts", "packages/resources/identity-admin/src/repositories/token.ts", null],
  [
    "src/repositories/user.ts",
    "packages/resources/identity-admin/src/repositories/user.ts",
    "packages/platform/identity/src/repositories/user.ts",
  ],
  [
    "web/components/ChangePasswordDialog.tsx",
    "packages/resources/identity-admin/web/components/ChangePasswordDialog.tsx",
    "packages/platform/identity/web/components/ChangePasswordDialog.tsx",
  ],
  [
    "web/src/__tests__/token-manager-dialog-form.test.ts",
    "packages/resources/identity-admin/web/src/__tests__/token-manager-dialog-form.test.ts",
    null,
  ],
  [
    "web/src/__tests__/token-stats.test.ts",
    "packages/resources/identity-admin/web/src/__tests__/token-stats.test.ts",
    null,
  ],
] as const;

describe("RMD-06 ownership migration", () => {
  // 仅这 12 个获批源文件迁入指定 owner，避免旧根路径或额外迁移悄然出现。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_06_MOVES).toHaveLength(12);
    for (const [source, rmd06Target, currentTarget] of RMD_06_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      if (currentTarget === null) {
        expect(existsSync(rmd06Target), `deleted in 1.2 but still present: ${rmd06Target}`).toBe(false);
        continue;
      }
      expect(existsSync(currentTarget), `current owner target is missing: ${currentTarget}`).toBe(true);
      if (currentTarget !== rmd06Target) {
        expect(existsSync(rmd06Target), `stale RMD-06 target still exists: ${rmd06Target}`).toBe(false);
      }
    }
  });
});
