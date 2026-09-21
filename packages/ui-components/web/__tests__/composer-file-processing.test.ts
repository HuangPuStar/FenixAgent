import { expect, test } from "bun:test";
import { uploadComposerFiles } from "../chat/composer/composer-file-processing";

/**
 * 输入岛附件上传的行为测试。
 *
 * 来源：`packages/agent-runtime/web/__tests__/composer-file-processing.test.ts` 迁移。
 * 纯化差异：源实现直连宿主 `uploadChatFiles(envId, files)`，测试靠 mock `globalThis.fetch`
 * 同时验证请求 URL 与附件映射；包内上传改为注入端口（`UploadComposerFiles`），
 * 请求 URL 由宿主装配决定（其覆盖见 `apps/web/src/__tests__/fs-upload-url.test.ts`），
 * 包内只对「服务端返回的 path 原样进入附件」负责。
 */

// Composer 使用服务端返回的权威 workspace 相对路径，避免文件重命名后消息引用失效。
test("uses uploaded workspace paths in chat attachments", async () => {
  const uploaded: File[][] = [];
  // 服务端返回的 path 与本地按文件名拼接的结果不同，确保附件用的是服务端权威路径
  const upload = async (files: File[]) => {
    uploaded.push(files);
    return [{ name: "SKILL.md", path: "user/2026/SKILL.md" }];
  };

  const attachments = await uploadComposerFiles([new File(["content"], "SKILL.md")], upload);

  expect(uploaded.length).toBe(1);
  expect(uploaded[0]?.map((file) => file.name)).toEqual(["SKILL.md"]);
  expect(attachments).toEqual([{ name: "SKILL.md", path: "user/2026/SKILL.md" }]);
});
