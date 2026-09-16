import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const RMD_06_MOVES = [
  [
    "src/repositories/resource-permission.ts",
    "packages/platform/access-control/src/repositories/resource-permission.ts",
  ],
  ["src/schemas/resource-access.schema.ts", "packages/platform/access-control/src/schemas/resource-access.schema.ts"],
  [
    "src/__tests__/resource-permission-service.test.ts",
    "packages/platform/access-control/src/__tests__/resource-permission-service.test.ts",
  ],
  [
    "src/__tests__/round23-resource-permission-isolation.test.ts",
    "packages/platform/access-control/src/__tests__/round23-resource-permission-isolation.test.ts",
  ],
  [
    "src/__tests__/round64-resource-permission-repository.test.ts",
    "packages/platform/access-control/src/__tests__/round64-resource-permission-repository.test.ts",
  ],
  ["src/routes/web/control.ts", "packages/resources/identity-admin/src/routes/web/control.ts"],
  ["src/repositories/share-link.ts", "packages/resources/identity-admin/src/repositories/share-link.ts"],
  ["src/repositories/token.ts", "packages/resources/identity-admin/src/repositories/token.ts"],
  ["src/repositories/user.ts", "packages/resources/identity-admin/src/repositories/user.ts"],
  [
    "web/components/ChangePasswordDialog.tsx",
    "packages/resources/identity-admin/web/components/ChangePasswordDialog.tsx",
  ],
  [
    "web/src/__tests__/token-manager-dialog-form.test.ts",
    "packages/resources/identity-admin/web/src/__tests__/token-manager-dialog-form.test.ts",
  ],
  ["web/src/__tests__/token-stats.test.ts", "packages/resources/identity-admin/web/src/__tests__/token-stats.test.ts"],
] as const;

describe("RMD-06 ownership migration", () => {
  // 仅这 12 个获批源文件迁入指定 owner，避免旧根路径或额外迁移悄然出现。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_06_MOVES).toHaveLength(12);
    for (const [source, target] of RMD_06_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `owner target is missing: ${target}`).toBe(true);
    }
  });
});
