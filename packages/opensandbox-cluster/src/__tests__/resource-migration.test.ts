import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabase } from "../db/client";
import { migrateConnection, migrateDatabase } from "../db/migrate";

// 首次启动时自动创建数据库父目录，迁移后能正常读写持久数据。
test("migration initializes a database inside missing parent directories", () => {
  const folder = mkdtempSync(join(tmpdir(), "cluster-first-start-"));
  const path = join(folder, "nested", "data", "cluster.db");
  try {
    migrateDatabase(path);
    const { sqlite } = createDatabase(path);
    try {
      sqlite.exec("INSERT INTO sandbox_pool(id,name,status,created_at,updated_at) VALUES ('p','Pool','active',1,1)");
      expect(sqlite.query("SELECT name FROM sandbox_pool WHERE id = 'p'").get()).toEqual({ name: "Pool" });
    } finally {
      sqlite.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// 旧数据库存在绑定和隧道凭据时升级，不能丢失记录或修改旧数量策略。
test("resource migration upgrades populated legacy schema without losing relationships", async () => {
  const folder = mkdtempSync(join(tmpdir(), "cluster-migration-"));
  const { db, sqlite } = createDatabase(":memory:");
  try {
    const source = new URL("../../drizzle/", import.meta.url);
    const journal = (await Bun.file(new URL("meta/_journal.json", source)).json()) as { entries: unknown[] };
    await Bun.write(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
    );
    for (const file of ["0000_initial.sql", "0001_server_tunnel.sql"])
      await Bun.write(join(folder, file), Bun.file(new URL(file, source)));
    migrate(db, { migrationsFolder: folder });
    sqlite.exec(
      "INSERT INTO sandbox_pool VALUES ('p','P','active',123,123); INSERT INTO opensandbox_server(id,pool_id,name,base_url,workspace_root,api_key_ciphertext,max_sandboxes,status,health_status,created_at,updated_at) VALUES ('n','p','N','http://node','/data','cipher',1,'active','healthy',123,123); INSERT INTO sandbox_binding VALUES ('s','p','n',123);",
    );
    // 零容量可由旧更新接口产生，升级不能拒绝存量节点或擅自恢复其容量。
    sqlite.exec(
      "INSERT INTO opensandbox_server(id,pool_id,name,base_url,workspace_root,api_key_ciphertext,max_sandboxes,status,health_status,created_at,updated_at) VALUES ('drained','p','Drained','http://node','/data','cipher',0,'active','healthy',123,123);",
    );
    migrateConnection(db, sqlite);
    expect(sqlite.query("SELECT allocation_mode,state,updated_at FROM sandbox_binding").get()).toEqual({
      allocation_mode: "count",
      state: "active",
      updated_at: 123,
    });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.query("SELECT scheduling_mode FROM sandbox_pool").get()).toEqual({ scheduling_mode: "count" });
    expect(sqlite.query("SELECT max_sandboxes FROM opensandbox_server WHERE id = 'drained'").get()).toEqual({
      max_sandboxes: 0,
    });
  } finally {
    sqlite.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
