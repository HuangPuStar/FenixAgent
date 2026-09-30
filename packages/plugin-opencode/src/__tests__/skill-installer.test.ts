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

  // 注入 origin 时应改写下载目标：ws(s) 按同 host:port 换算成 http(s)，path 与 query 逐字保留。
  test("rewrites the skill download origin when a download origin is injected", async () => {
    const workspace = await createWorkspace();
    try {
      const requestedUrls: string[] = [];
      const mockFetch = (async (url: string) => {
        requestedUrls.push(String(url));
        return new Response("zip-bytes");
      }) as unknown as typeof fetch;

      await installSkills(
        workspace,
        [{ name: "code-review", url: "https://localhost:3000/skills/code-review/download?token=abc" }],
        {
          downloadOrigin: "ws://host.docker.internal:3000",
          fetch: mockFetch,
          extractArchive: async (_archivePath, targetDir) => {
            await writeFile(join(targetDir, "SKILL.md"), "# code-review\n", "utf8");
          },
        },
      );

      expect(requestedUrls).toEqual(["http://host.docker.internal:3000/skills/code-review/download?token=abc"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 未注入 origin 时必须逐字使用 launchSpec 里的 URL：宿主自身生成的地址本就可达，隐式改写会静默换错目标。
  test("keeps the original skill url when no download origin is injected", async () => {
    const workspace = await createWorkspace();
    try {
      const requestedUrls: string[] = [];
      const mockFetch = (async (url: string) => {
        requestedUrls.push(String(url));
        return new Response("zip-bytes");
      }) as unknown as typeof fetch;
      const originalUrl = "http://127.0.0.1:3000/skills/code-review/download?token=abc";

      await installSkills(workspace, [{ name: "code-review", url: originalUrl }], {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# code-review\n", "utf8");
        },
      });

      expect(requestedUrls).toEqual([originalUrl]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
