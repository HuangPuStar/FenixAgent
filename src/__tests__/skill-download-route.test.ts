import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Elysia from "elysia";
import { setConfig } from "../config";
import { generateSkillDownloadToken } from "../services/skill-download-token";

let rows: Array<{ id: string }> = [];

mock.module("../db", () => ({
  db: {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(async () => rows),
        })),
      })),
    })),
  },
}));

const webSkills = (await import("../routes/web/skills")).default;

const skill = { id: "skill-1", organizationId: "org-1", name: "demo" };

function requestUrl(name: string, token?: string): string {
  const query = token === undefined ? "" : `?token=${token}`;
  return `http://localhost/web/skills/${encodeURIComponent(name)}/download${query}`;
}

describe("skill download route", () => {
  let root: string;
  let app: Elysia;

  beforeEach(async () => {
    process.env.RCS_API_KEYS = "test-key";
    rows = [{ id: "skill-1" }];
    root = await mkdtemp(join(tmpdir(), "skill-download-route-"));
    setConfig({ skillDir: root });
    app = new Elysia().use(webSkills);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeArchive(name = "demo", content = "zip-bytes") {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${name}.zip`), content);
  }

  // token 正确且 archive 存在时返回 zip 文件内容。
  test("returns zip when token and archive are valid", async () => {
    await writeArchive("demo", "zip-content");
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });

    const res = await app.handle(new Request(requestUrl("demo", token)));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(await res.text()).toBe("zip-content");
  });

  // 缺少 token 时拒绝下载。
  test("missing token returns 403", async () => {
    const res = await app.handle(new Request(requestUrl("demo")));
    expect(res.status).toBe(403);
  });

  // token 绑定的 skillName 必须匹配路径参数。
  test("token skillName mismatch returns 403", async () => {
    const token = generateSkillDownloadToken({ ...skill, name: "other" }, { expiresInSeconds: 60 });
    const res = await app.handle(new Request(requestUrl("demo", token)));
    expect(res.status).toBe(403);
  });

  // DB 中没有启用的全局 skill 时返回 404。
  test("disabled or missing db skill returns 404", async () => {
    rows = [];
    await writeArchive("demo");
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });

    const res = await app.handle(new Request(requestUrl("demo", token)));

    expect(res.status).toBe(404);
  });

  // 过期 token 被视为无效 token。
  test("expired token returns 403", async () => {
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: -1 });
    const res = await app.handle(new Request(requestUrl("demo", token)));
    expect(res.status).toBe(403);
  });

  // token 正确但 archive 缺失时返回 404。
  test("missing archive returns 404", async () => {
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });
    const res = await app.handle(new Request(requestUrl("demo", token)));
    expect(res.status).toBe(404);
  });

  // 非法路径名会在 token 验证前被拒绝。
  test("invalid skill name returns 400", async () => {
    const token = generateSkillDownloadToken({ ...skill, name: "../x" }, { expiresInSeconds: 60 });
    const res = await app.handle(new Request(requestUrl("../x", token)));
    expect(res.status).toBe(400);
  });
});
