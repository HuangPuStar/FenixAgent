import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createMcpServerRepository } from "../server/repositories/mcp-server";
import { createMcpServerService } from "../server/services/mcp-server-service";

const pool = process.env.TEST_EXTERNAL_API_DATABASE_URL
  ? new Pool({ connectionString: process.env.TEST_EXTERNAL_API_DATABASE_URL })
  : undefined;
const userId = `mcp-enabled-${randomUUID()}`;
const noRead = async (): Promise<never> => {
  throw new Error("unexpected authorized read");
};
const service = createMcpServerService(createMcpServerRepository({ list: noRead, count: noRead, findById: noRead }));
beforeEach(async () => {
  if (!pool) return;
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: drizzle(pool) });
  await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1::text,$1::text,$2::text) ON CONFLICT DO NOTHING', [
    userId,
    `${userId}@example.test`,
  ]);
});
afterEach(resetAllStubs);
afterAll(async () => {
  if (pool) {
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
    await pool.end();
  }
});
// 完整配置中的 enabled 与权威列必须一起写入，创建和替换都不能静默启用工具。
test.skipIf(!pool)("MCP full configuration atomically persists enabled on create and update", async () => {
  const id = await service.create({
    name: "disabled-tool",
    organizationId: userId,
    ownerUserId: userId,
    visibility: "private",
    type: "local",
    config: { type: "local", command: ["tool"], enabled: false },
  });
  expect((await service.findRowUnscoped(id!))?.enabled).toBe(false);
  await service.update({ resourceId: id!, config: { type: "local", command: ["tool"], enabled: true } });
  expect((await service.findRowUnscoped(id!))?.enabled).toBe(true);
  await service.update({ resourceId: id!, config: { type: "local", command: ["new-tool"], enabled: false } });
  expect((await service.findRowUnscoped(id!))?.enabled).toBe(false);
  await service.update({ resourceId: id!, config: { type: "local", command: ["new-tool"] } });
  expect((await service.findRowUnscoped(id!))?.enabled).toBe(false);
});
