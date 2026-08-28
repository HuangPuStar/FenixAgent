import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "../runtime/skill-installer";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-opencode-skills-"));
}

describe("skill-installer", () => {
  // skill zip 必须在 workspace 文件系统内暂存，避免跨设备替换失败。
  test("stages an archive inside the workspace before installing SKILL.md into .opencode/skills/<name>", async () => {
    const workspace = await createWorkspace();
    try {
      const mockFetch = (async () => new Response("zip-bytes")) as unknown as typeof fetch;
      let stagedTargetDir: string | undefined;
      const installed = await installSkills(
        workspace,
        [{ name: "code-review", url: "https://example.com/code-review.zip" }],
        {
          fetch: mockFetch,
          extractArchive: async (_archivePath, targetDir) => {
            stagedTargetDir = targetDir;
            await writeFile(join(targetDir, "SKILL.md"), "# code-review\n", "utf8");
          },
        },
      );

      expect(stagedTargetDir).toStartWith(join(workspace, ".opencode", ".plugin-opencode-skills-"));

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

  // 新 skill 下载失败时必须保留旧目录，避免刷新失败破坏现有会话。
  test("keeps previously installed skills when a replacement download fails", async () => {
    const workspace = await createWorkspace();
    try {
      const successfulFetch = (async () => new Response("zip-bytes")) as unknown as typeof fetch;
      await installSkills(workspace, [{ name: "existing", url: "https://example.com/existing.zip" }], {
        fetch: successfulFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# existing\n", "utf8");
        },
      });

      const failedFetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
      await expect(
        installSkills(workspace, [{ name: "replacement", url: "https://example.com/replacement.zip" }], {
          fetch: failedFetch,
        }),
      ).rejects.toThrow("Failed to download skill 'replacement'");

      await expect(readFile(join(workspace, ".opencode", "skills", "existing", "SKILL.md"), "utf8")).resolves.toContain(
        "existing",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
