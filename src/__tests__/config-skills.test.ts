import { describe, test, expect, beforeEach, mock } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// Create temp directories for skill testing
const tempDir = await mkdtemp(join(tmpdir(), "skill-route-test-"));
const skillsDir = join(tempDir, "skills");
const disabledDir = join(skillsDir, "_disabled");
let importResult: { imported: any[]; skipped: string[]; conflicts: any[] } = { imported: [], skipped: [], conflicts: [] };
let importError: (Error & { code?: string }) | null = null;

// Helper to create a skill SKILL.md
async function createSkill(dir: string, name: string, description: string, content: string, extraMeta?: Record<string, string>) {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const meta: Record<string, string> = { name, description, ...extraMeta };
  const frontmatter = Object.entries(meta).map(([k, v]) => `${k}: "${v}"`).join("\n");
  await writeFile(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n${content}`, "utf-8");
}

// Mock auth
mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "test-user", email: "test@test.com", name: "Test" },
        session: { id: "sess_test", userId: "test-user", token: "tok" },
      }),
      signUpEmail: async () => ({}),
    },
  },
}));

mock.module("../services/team", () => ({
  getAuthContext: async () => ({ teamId: "test-team", userId: "test-user", role: "owner" }),
    getAuthContextByTeamId: async () => ({ teamId: "test-team", userId: "test-user", role: "owner" }),
  ensurePersonalTeam: async () => {},
  listMyTeams: async () => [{ id: "test-team", name: "Test Team", slug: "test-team" }],
  getTeamDetail: async () => null,
  createTeam: async () => null,
  switchTeam: async () => null,
  addMember: async () => {},
  removeMember: async () => false,
  updateRole: async () => false,
  getTeamMembers: async () => [],
  updateTeam: async () => false,
  deleteTeam: async () => false,
}));

// Mock skill service to use temp directories
mock.module("../services/skill", () => ({
  SKILLS_DIR: skillsDir,
  listSkills: async (_ctx: any) => {
    const { readdir, readFile } = await import("node:fs/promises");
    const skills: any[] = [];
    if (existsSync(skillsDir)) {
      for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "_disabled") continue;
        const mdPath = join(skillsDir, entry.name, "SKILL.md");
        if (!existsSync(mdPath)) continue;
        const raw = await readFile(mdPath, "utf-8");
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        const metadata: Record<string, string> = {};
        if (match) {
          for (const line of match[1].split("\n")) {
            const idx = line.indexOf(":");
            if (idx > 0) metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
          }
        }
        skills.push({ name: entry.name, enabled: true, description: metadata.description ?? "", path: mdPath });
      }
    }
    if (existsSync(disabledDir)) {
      for (const entry of await readdir(disabledDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "_disabled") continue;
        const mdPath = join(disabledDir, entry.name, "SKILL.md");
        if (!existsSync(mdPath)) continue;
        const raw = await readFile(mdPath, "utf-8");
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        const metadata: Record<string, string> = {};
        if (match) {
          for (const line of match[1].split("\n")) {
            const idx = line.indexOf(":");
            if (idx > 0) metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
          }
        }
        skills.push({ name: entry.name, enabled: false, description: metadata.description ?? "", path: mdPath });
      }
    }
    return skills;
  },
  getSkill: async (_ctx: any, name: string) => {
    const { readFile } = await import("node:fs/promises");
    const enabledPath = join(skillsDir, name, "SKILL.md");
    const disabledPath = join(disabledDir, name, "SKILL.md");
    const filePath = existsSync(enabledPath) ? enabledPath : existsSync(disabledPath) ? disabledPath : null;
    if (!filePath) return null;
    const raw = await readFile(filePath, "utf-8");
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    const metadata: Record<string, string> = {};
    let content = raw;
    if (match) {
      for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
      }
      content = match[2];
    }
    return { name, description: metadata.description ?? "", content, enabled: filePath === enabledPath, path: filePath, metadata };
  },
  setSkill: async (_ctx: any, name: string, data: { description: string; content: string; metadata?: Record<string, string> }) => {
    // Delete old
    const enabledDir = join(skillsDir, name);
    const disabledDirPath = join(disabledDir, name);
    if (existsSync(enabledDir)) await rm(enabledDir, { recursive: true, force: true });
    if (existsSync(disabledDirPath)) await rm(disabledDirPath, { recursive: true, force: true });
    // Create new
    const skillDir = join(skillsDir, name);
    await mkdir(skillDir, { recursive: true });
    await createSkill(skillsDir, name, data.description, data.content, data.metadata);
    return { name, enabled: true, description: data.description, path: join(skillDir, "SKILL.md") };
  },
  deleteSkill: async (_ctx: any, name: string) => {
    const enabledDir = join(skillsDir, name);
    const disabledDirPath = join(disabledDir, name);
    let deleted = false;
    if (existsSync(enabledDir)) { await rm(enabledDir, { recursive: true, force: true }); deleted = true; }
    if (existsSync(disabledDirPath)) { await rm(disabledDirPath, { recursive: true, force: true }); deleted = true; }
    return deleted;
  },
  enableSkill: async (_ctx: any, name: string) => {
    const { rename } = await import("node:fs/promises");
    const from = join(disabledDir, name);
    const to = join(skillsDir, name);
    if (!existsSync(from)) return false;
    await rename(from, to);
    return true;
  },
  disableSkill: async (_ctx: any, name: string) => {
    const { rename } = await import("node:fs/promises");
    const from = join(skillsDir, name);
    const to = join(disabledDir, name);
    if (!existsSync(from)) return false;
    if (!existsSync(disabledDir)) await mkdir(disabledDir, { recursive: true });
    await rename(from, to);
    return true;
  },
  importSkillDirectories: async (_ctx: any) => {
    if (importError) throw importError;
    return importResult;
  },
  importWorkspaceSkillDirectories: async (_ctx: any) => {
    if (importError) throw importError;
    return importResult;
  },
  listSkillSources: async () => [],
  getWorkspaceSkill: async () => null,
  setWorkspaceSkill: async (_ws: string, _name: string, data: any) => ({ name: _name, enabled: true, description: data.description }),
  deleteWorkspaceSkill: async () => true,
  listWorkspaceSkills: async () => [],
}));

const skillsRoute = (await import("../routes/web/config/skills")).default;

describe("Skills Config Route", () => {
  beforeEach(async () => {
    if (existsSync(skillsDir)) await rm(skillsDir, { recursive: true, force: true });
    if (existsSync(disabledDir)) await rm(disabledDir, { recursive: true, force: true });
    await mkdir(skillsDir, { recursive: true });
    importResult = { imported: [], skipped: [], conflicts: [] };
    importError = null;
  });

  test("list 返回空列表", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.skills).toEqual([]);
  });

  test("list 返回已启用和已禁用 skill", async () => {
    await createSkill(skillsDir, "enabled-skill", "Enabled", "# Enabled");
    await mkdir(disabledDir, { recursive: true });
    await createSkill(disabledDir, "disabled-skill", "Disabled", "# Disabled");
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    }));
    const json = await res.json();
    expect(json.data.skills).toHaveLength(2);
    expect(json.data.skills.find((s: any) => s.name === "enabled-skill")!.enabled).toBe(true);
    expect(json.data.skills.find((s: any) => s.name === "disabled-skill")!.enabled).toBe(false);
  });

  test("get 返回 skill 详情", async () => {
    await createSkill(skillsDir, "test-skill", "A test skill", "# Test\nHello world", { version: "1.0" });
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "test-skill" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("test-skill");
    expect(json.data.description).toBe("A test skill");
    expect(json.data.content).toBe("# Test\nHello world");
    expect(json.data.enabled).toBe(true);
  });

  test("get 不存在 skill", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "ghost" }),
    }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("get 缺少 name", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("set 创建新 skill", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "new-skill", data: { description: "New", content: "# New" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("new-skill");
    expect(json.data.enabled).toBe(true);
    expect(existsSync(join(skillsDir, "new-skill", "SKILL.md"))).toBe(true);
  });

  test("set 覆盖已禁用 skill", async () => {
    await createSkill(skillsDir, "my-skill", "Old", "# Old");
    await mkdir(disabledDir, { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(join(skillsDir, "my-skill"), join(disabledDir, "my-skill"));

    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "my-skill", data: { description: "Updated", content: "# Updated" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(true);
    expect(existsSync(join(skillsDir, "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(disabledDir, "my-skill"))).toBe(false);
  });

  test("set 缺少必填字段", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "x", data: { description: "D" } }),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("delete 已存在 skill", async () => {
    await createSkill(skillsDir, "to-delete", "Del", "# Del");
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "to-delete" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(existsSync(join(skillsDir, "to-delete"))).toBe(false);
  });

  test("delete 不存在 skill", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "ghost" }),
    }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("enable 禁用→启用", async () => {
    await createSkill(skillsDir, "toggle", "Toggle", "# T");
    await mkdir(disabledDir, { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(join(skillsDir, "toggle"), join(disabledDir, "toggle"));

    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enable", name: "toggle" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(true);
    expect(existsSync(join(skillsDir, "toggle"))).toBe(true);
  });

  test("enable 不存在 skill", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enable", name: "ghost" }),
    }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("disable 启用→禁用", async () => {
    await createSkill(skillsDir, "toggle2", "T2", "# T2");
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", name: "toggle2" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(false);
    expect(existsSync(join(disabledDir, "toggle2"))).toBe(true);
  });

  test("disable 不存在 skill", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", name: "ghost" }),
    }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("未知 action", async () => {
    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unknown" }),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("upload 冲突时返回 409 和策略", async () => {
    importResult = {
      imported: [],
      skipped: [],
      conflicts: [{ name: "existing", enabled: true, path: join(skillsDir, "existing", "SKILL.md") }],
    };
    const formData = new FormData();
    formData.append("manifest", JSON.stringify([{ skillName: "existing", relativePath: "SKILL.md" }]));
    formData.append("files", new File(["---\nname: \"existing\"\n---\n# Existing"], "SKILL.md"));

    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills/upload", {
      method: "POST",
      body: formData,
    }));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("SKILL_CONFLICT");
    expect(json.data.allowedStrategies).toEqual(["ignore", "overwrite"]);
    expect(json.data.conflicts).toHaveLength(1);
  });

  test("upload ignore 成功返回 imported 和 skipped", async () => {
    importResult = {
      imported: [{ name: "fresh", enabled: true, description: "Fresh", path: join(skillsDir, "fresh", "SKILL.md") }],
      skipped: ["existing"],
      conflicts: [],
    };
    const formData = new FormData();
    formData.append("manifest", JSON.stringify([
      { skillName: "fresh", relativePath: "SKILL.md" },
      { skillName: "fresh", relativePath: "references/ref.md" },
    ]));
    formData.append("conflictStrategy", "ignore");
    formData.append("files", new File(["---\ndescription: \"Fresh\"\n---\n# Fresh"], "SKILL.md"));
    formData.append("files", new File(["ref"], "ref.md"));

    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills/upload", {
      method: "POST",
      body: formData,
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.imported[0].name).toBe("fresh");
    expect(json.data.skipped).toEqual(["existing"]);
  });

  test("upload 缺少 manifest 返回 VALIDATION_ERROR", async () => {
    const formData = new FormData();
    formData.append("files", new File(["x"], "SKILL.md"));

    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills/upload", {
      method: "POST",
      body: formData,
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("upload 服务校验错误映射为 400", async () => {
    importError = Object.assign(new Error("Skill 缺少 SKILL.md"), { code: "VALIDATION_ERROR" });
    const formData = new FormData();
    formData.append("manifest", JSON.stringify([{ skillName: "broken", relativePath: "notes.md" }]));
    formData.append("files", new File(["# Broken"], "notes.md"));

    const res = await skillsRoute.handle(new Request("http://localhost/web/config/skills/upload", {
      method: "POST",
      body: formData,
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });
});

// Cleanup
import { afterAll } from "bun:test";
afterAll(async () => {
  if (existsSync(tempDir)) await rm(tempDir, { recursive: true, force: true });
});
