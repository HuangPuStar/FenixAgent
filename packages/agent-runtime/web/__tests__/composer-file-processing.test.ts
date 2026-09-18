import { expect, mock, test } from "bun:test";
import {
  type UploadComposerFiles,
  uploadComposerFiles,
} from "@fenix/ui-components/chat/composer/composer-file-processing";

// Composer 使用服务端返回的权威 workspace 相对路径，避免文件重命名后消息引用失效。
// 纯化契约：网络上传由宿主注入（源实现直连 `@/src/api/fs` 的 uploadChatFiles），
// 这里用桩替代宿主上传实现，覆盖「文件原样交给上传实现 + 附件沿用服务端返回路径」。
test("uses uploaded workspace paths in chat attachments", async () => {
  const uploaded = [{ name: "SKILL.md", path: "user/2026/SKILL.md" }];
  const upload = mock(async () => uploaded) as unknown as UploadComposerFiles;
  const file = new File(["content"], "SKILL.md");

  const attachments = await uploadComposerFiles([file], upload);

  // 待上传文件原样交给注入的上传实现
  expect(upload).toHaveBeenCalledWith([file]);
  // 附件路径取自服务端返回（与本地文件名拼出的 "user/SKILL.md" 不同）
  expect(attachments).toEqual([{ name: "SKILL.md", path: "user/2026/SKILL.md" }]);
});
