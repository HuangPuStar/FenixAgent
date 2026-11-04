import { afterEach, expect, test } from "bun:test";
import type { AgentFileService } from "../services/agent-file-service";
import { setApiWorkspaceDeps, uploadWorkspaceFiles } from "../services/api-workspace";

afterEach(() => setApiWorkspaceDeps(null));
// 整批输入必须在统一执行面写盘之前校验，避免第二个目标非法时已写第一个。
test("v1 upload rejects duplicate and mismatched targets before writing", async () => {
  let writes = 0;
  setApiWorkspaceDeps({
    createAgentFileService: () =>
      ({
        upload: async () => {
          writes++;
          return { files: [] };
        },
      }) as unknown as AgentFileService,
  });
  for (const paths of [["same.txt", "same.txt"], ["only.txt"], ["valid.txt", "../escape.txt"]]) {
    const form = new FormData();
    form.append("files", new File(["a"], "a.txt"));
    form.append("files", new File(["b"], "b.txt"));
    form.set("relativePaths", JSON.stringify(paths));
    await expect(uploadWorkspaceFiles("env", form, "user")).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(writes).toBe(0);
});
// API 审计身份必须沿用统一文件执行路径，文件仍属于 Environment 工作区。
test("v1 upload delegates to the shared file service with authenticated audit scope", async () => {
  let scope: unknown;
  setApiWorkspaceDeps({
    createAgentFileService: (input) => {
      scope = input;
      return {
        upload: async (dir, files) => ({
          files: files.map((f) => ({ name: f.name, path: `${dir}/${f.relativePath}`, size: f.content.byteLength })),
        }),
      } as unknown as AgentFileService;
    },
  });
  const form = new FormData();
  form.append("files", new File(["hello"], "note.txt"));
  expect(await uploadWorkspaceFiles("env", form, "owner")).toEqual({
    environmentId: "env",
    files: [{ name: "note.txt", path: "user/note.txt", size: 5 }],
  });
  expect(scope).toEqual({ environmentId: "env", actorId: "owner", source: "api" });
});
