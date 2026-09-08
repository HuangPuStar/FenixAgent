import { expect, mock, test } from "bun:test";
import { uploadComposerFiles } from "@/components/chat/composer-file-processing";

// Composer 使用服务端返回的权威 workspace 相对路径，避免文件重命名后消息引用失效。
test("uses uploaded workspace paths in chat attachments", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return Response.json({
      success: true,
      data: { files: [{ name: "SKILL.md", path: "user/SKILL.md", size: 7 }] },
    });
  }) as unknown as typeof fetch;

  try {
    const attachments = await uploadComposerFiles("env-a", [new File(["content"], "SKILL.md")]);
    expect(requestedUrl).toBe("/web/environments/env-a/fs/user");
    expect(attachments).toEqual([{ name: "SKILL.md", path: "user/SKILL.md" }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
