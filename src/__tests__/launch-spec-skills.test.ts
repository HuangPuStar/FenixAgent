import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { buildLaunchSpec } from "../services/launch-spec-builder";
import { verifySkillDownloadToken } from "../services/skill-download-token";

const originalEnv = { ...process.env };

function baseConfig(skills: unknown[]) {
  return {
    agentConfig: null,
    providers: [],
    mcpServers: [],
    skills,
  };
}

function skillRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${name}-id`,
    organizationId: "org-1",
    userId: "user-1",
    environmentId: null,
    agentConfigId: null,
    name,
    description: "",
    contentPath: null,
    metadata: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("launch spec skills", () => {
  let root: string;

  beforeEach(async () => {
    process.env.RCS_API_KEYS = "test-key";
    root = await mkdtemp(join(tmpdir(), "launch-spec-skills-"));
    setConfig({ skillDir: root, baseUrl: "http://rcs.test" });
  });

  afterEach(async () => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    await rm(root, { recursive: true, force: true });
    setConfig({ baseUrl: "" });
  });

  async function writeArchive(name: string) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${name}.zip`), "zip");
  }

  async function specFor(skills: unknown[]) {
    return buildLaunchSpec({
      organizationId: "org-test",
      userId: "user-test",
      agentName: "build",
      fullConfig: baseConfig(skills) as any,
      environmentSecret: "secret",
    });
  }

  // enabled 的全局 skill 和 agent-scoped skill 都会进入 launch spec。
  test("enabled global and agent-scoped skills are included", async () => {
    await writeArchive("global-skill");
    await writeArchive("agent-skill");

    const spec = await specFor([
      skillRow("global-skill"),
      skillRow("agent-skill", { id: "agent-skill-id", agentConfigId: "agent-config-1" }),
    ]);

    expect(spec.skills.map((skill) => skill.name)).toEqual(["global-skill", "agent-skill"]);
  });

  // disabled skill 即使存在 archive 也不会进入 launch spec。
  test("disabled skills are filtered out", async () => {
    await writeArchive("disabled-skill");

    const spec = await specFor([skillRow("disabled-skill", { enabled: false })]);

    expect(spec.skills).toEqual([]);
  });

  // enabled skill 缺少 zip artifact 时跳过而非抛错，避免阻塞 agent 启动。
  test("enabled skill missing archive is skipped", async () => {
    const spec = await specFor([skillRow("missing")]);
    expect(spec.skills).toEqual([]);
  });

  // URL 包含下载路由和可验证的 skill token。
  test("skill url contains verifiable download token", async () => {
    await writeArchive("encoded skill");

    const spec = await specFor([skillRow("encoded skill", { id: "skill-encoded", organizationId: "org-encoded" })]);
    const [entry] = spec.skills;
    const url = new URL(entry.url);

    expect(url.origin + url.pathname).toBe("http://rcs.test/web/skills/encoded%20skill/download");
    const payload = verifySkillDownloadToken(url.searchParams.get("token") ?? "");
    expect(payload).toMatchObject({
      skillId: "skill-encoded",
      organizationId: "org-encoded",
      skillName: "encoded skill",
    });
  });
});
