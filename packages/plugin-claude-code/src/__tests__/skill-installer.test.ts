import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "../runtime/skill-installer";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-claude-code-skills-"));
}

describe("claude-code skill-installer", () => {
  // skill zip 安装
  test("downloads an archive and extracts SKILL.md into .claude/skills/<name>", async () => {
    const workspace = await createWorkspace();
    try {
      const mockFetch = (async () => new Response("zip-bytes")) as unknown as typeof fetch;
      const installed = await installSkills(
        workspace,
        [{ name: "code-review", url: "https://example.com/code-review.zip" }],
        {
          fetch: mockFetch,
          extractArchive: async (_archivePath, targetDir) => {
            await writeFile(join(targetDir, "SKILL.md"), "# code-review\n", "utf8");
          },
        },
      );

      expect(installed).toEqual([
        {
          name: "code-review",
          path: join(workspace, ".claude", "skills", "code-review"),
        },
      ]);
      expect(await readFile(join(installed[0].path, "SKILL.md"), "utf8")).toContain("code-review");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // skill 从有到无时，应清理 workspace 中残留的旧 skill 目录
  test("removes stale installed skills when launchSpec no longer declares them", async () => {
    const workspace = await createWorkspace();
    try {
      const mockFetch = (async () => new Response("zip-bytes")) as unknown as typeof fetch;
      await installSkills(workspace, [{ name: "code-review", url: "https://example.com/code-review.zip" }], {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# code-review\n", "utf8");
        },
      });

      await expect(access(join(workspace, ".claude", "skills", "code-review", "SKILL.md"))).resolves.toBeNull();

      await installSkills(workspace, [], { fetch: mockFetch });

      await expect(access(join(workspace, ".claude", "skills", "code-review"))).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
