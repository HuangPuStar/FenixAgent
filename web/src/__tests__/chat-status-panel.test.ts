import { describe, expect, test } from "bun:test";

import { fileNameFromPath } from "../../components/chat/chat-status-panel";

describe("ChatStatusPanel 文件名称", () => {
  // Changes 只展示文件名，完整绝对路径继续由状态面板保留用于预览定位。
  test("从 Unix 绝对路径提取文件名", () => {
    expect(fileNameFromPath("/opt/app/tmp/session/src/agent-sites.md")).toBe("agent-sites.md");
  });

  // Windows 路径也应按文件名展示，避免平台差异泄漏完整工作区路径。
  test("从 Windows 路径提取文件名", () => {
    expect(fileNameFromPath("C:\\workspace\\src\\agent-sites.md")).toBe("agent-sites.md");
  });

  // 目录型路径没有末尾文件段时回退到最后一个有效目录名。
  test("忽略路径末尾斜杠", () => {
    expect(fileNameFromPath("/opt/app/project/")).toBe("project");
  });
});
