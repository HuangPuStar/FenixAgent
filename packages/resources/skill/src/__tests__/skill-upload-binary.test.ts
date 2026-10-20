import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillUploadForm } from "../server/routes/skill-upload-form";
import { writeImportFiles } from "../server/services/skill-fs";

/**
 * 上传协议的二进制保真回归（VER-REVIEW-003）。
 *
 * 解析曾统一调用 `File.text()`，把附件按 UTF-8 解码后再以 UTF-8 落盘，PNG 等二进制文件在导入阶段
 * 即被 U+FFFD 替换而损坏；下载侧本就用 Buffer 读写，因此只需保证「解析 → 落盘」按原始字节传递。
 */

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

/** 一段包含非法 UTF-8 序列的二进制内容，覆盖 PNG 文件头与随机字节。 */
function binaryFixture(): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) & 0xff;
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

describe("技能目录上传的二进制保真", () => {
  // 二进制附件必须逐字节经过解析与落盘，任何文本解码都会改变长度与内容。
  test("解析与落盘后二进制附件字节不变", async () => {
    const bin = binaryFixture();
    const text = new TextEncoder().encode("# 说明\n正文");

    const formData = new FormData();
    formData.append(
      "manifest",
      JSON.stringify([
        { skillName: "demo", relativePath: "SKILL.md" },
        { skillName: "demo", relativePath: "assets/pic.bin" },
      ]),
    );
    // 文件顺序必须与 manifest 一一对应：解析按同一索引配对。
    formData.append("files", new Blob([text]), "SKILL.md");
    formData.append("files", new Blob([bin]), "pic.bin");

    const request = new Request("http://localhost/upload", { method: "POST", body: formData });
    const parsed = await readSkillUploadForm(request);
    const binFile = parsed.files.find((file) => file.relativePath === "assets/pic.bin");
    expect(binFile?.content).toEqual(bin);

    const targetDir = await mkdtemp(join(tmpdir(), "rcs-skill-upload-"));
    cleanup.push(() => rm(targetDir, { recursive: true, force: true }));
    await writeImportFiles(targetDir, [["demo", parsed.files]]);

    const written = await readFile(join(targetDir, "demo", "assets", "pic.bin"));
    expect(new Uint8Array(written)).toEqual(bin);
    expect(await readFile(join(targetDir, "demo", "SKILL.md"))).toEqual(Buffer.from(text));
  });
});
