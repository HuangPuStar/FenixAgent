import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

function readProjectFile(path: string) {
  return readFileSync(join(root, path), "utf-8");
}

describe("resource_permission 仓储结构", () => {
  // 迁移文件包含资源权限表、枚举、索引和 NULLS NOT DISTINCT 唯一语义
  test("迁移文件与 schema 唯一语义保持一致", () => {
    const migration0002 = readProjectFile("drizzle/0002_resource_permission.sql");
    const migration0003 = readProjectFile("drizzle/0003_resource_permission_nulls_not_distinct.sql");
    const snapshot0003 = readProjectFile("drizzle/meta/0003_snapshot.json");

    expect(migration0002).toContain('CREATE TYPE "public"."resource_permission_type"');
    expect(migration0002).toContain('CREATE TYPE "public"."resource_permission_principal"');
    expect(migration0002).toContain('CREATE TYPE "public"."resource_permission_action"');
    expect(migration0002).toContain('CREATE TABLE "resource_permission"');
    expect(migration0002).toContain('CREATE UNIQUE INDEX "idx_resource_permission_unique"');
    expect(migration0002).toContain('CREATE INDEX "idx_resource_permission_org_type"');
    expect(migration0002).toContain('CREATE INDEX "idx_resource_permission_principal_action"');
    expect(migration0002).toContain('CREATE INDEX "idx_resource_permission_resource"');
    expect(migration0003).toContain('DROP INDEX "idx_resource_permission_unique"');
    expect(migration0003).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(snapshot0003).toContain('"idx_resource_permission_unique"');
    expect(snapshot0003).toContain('"nullsNotDistinct": true');
  });

  // schema.ts 导出资源权限枚举和表定义
  test("schema 出口完整", () => {
    const schema = readProjectFile("src/db/schema.ts");

    expect(schema).toContain("export const resourcePermissionTypeEnum");
    expect(schema).toContain("export const resourcePermissionPrincipalEnum");
    expect(schema).toContain("export const resourcePermissionActionEnum");
    expect(schema).toContain("export const resourcePermission = pgTable");
    expect(schema).toContain('unique("idx_resource_permission_unique")');
    expect(schema).toContain(".nullsNotDistinct()");
  });

  // repository barrel 导出 repo 与所有权限类型
  test("repository barrel 导出完整", () => {
    const repositories = readProjectFile("src/repositories/index.ts");

    expect(repositories).toContain("resourcePermissionRepo");
    expect(repositories).toContain("ResourcePermissionType");
    expect(repositories).toContain("ResourcePermissionPrincipalType");
    expect(repositories).toContain("ResourcePermissionAction");
    expect(repositories).toContain("ResourcePermissionAccessibleRow");
    expect(repositories).toContain("CreateResourcePermissionGrantInput");
    expect(repositories).toContain("DeleteResourcePermissionGrantInput");
  });
});
