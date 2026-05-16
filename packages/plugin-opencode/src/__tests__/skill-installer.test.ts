import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "../runtime/skill-installer";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-opencode-skills-"));
}

describe("skill-installer", () => {
  // skill zip 安装
  test("downloads an archive and extracts SKILL.md into .opencode/skills/<name>", async () => {
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
          path: join(workspace, ".opencode", "skills", "code-review"),
        },
      ]);
      expect(await readFile(join(installed[0].path, "SKILL.md"), "utf8")).toContain("code-review");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
