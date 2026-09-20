import { ValidationError } from "@fenix/platform-sdk";
import type { UploadSkillFile } from "../services/skill-content";

/**
 * 两个技能上传入口共用的 multipart 表单解析（控制台 `/web/config/skills/upload` 与对外
 * `/api/skills`）。
 *
 * 它不是路由：只解析上传协议中形状相同的部分（manifest 与文件一一对应），冲突策略等入口特有的语义
 * 留给各自的路由。放在 `routes/` 下与 `agent-route-support.ts` 同类——都是协议层的公共设施，不注册
 * 端点、不承载业务规则。
 *
 * 表单结构不合法一律抛宿主 `ValidationError`：协议层的校验失败是 400，不是 500。
 */

/**
 * 上传表单类型，取自 `Request.formData()`。
 *
 * 不直接写 `FormData`：环境里 DOM lib 与 undici 各自声明了一个同名结构，用全局名会把运行时拿到的
 * 那一份判定为不可赋值。调用方只用到 `get` / `getAll`，两者语义一致。
 */
export type UploadFormData = Awaited<ReturnType<Request["formData"]>>;

/** manifest 条目；`skillName` 把一次上传的多个文件归到同一个技能目录下。 */
export interface SkillUploadManifestEntry {
  readonly skillName: string;
  readonly relativePath: string;
}

/** 解析结果；`formData` 原样返回，让调用方读取自己关心的策略字段（`conflictStrategy` / `overwrite`）。 */
export interface SkillUploadForm {
  readonly files: UploadSkillFile[];
  readonly formData: UploadFormData;
}

function parseManifest(raw: string): SkillUploadManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("manifest 格式无效");
  }
  if (!Array.isArray(parsed)) throw new ValidationError("manifest 格式无效");
  return parsed as SkillUploadManifestEntry[];
}

/** 解析上传表单中的 manifest 与文件；两者数量必须一致，否则文件与技能会错位。 */
export async function readSkillUploadForm(request: Request): Promise<SkillUploadForm> {
  let formData: UploadFormData;
  try {
    formData = await request.formData();
  } catch {
    throw new ValidationError("上传表单解析失败");
  }

  const manifestRaw = formData.get("manifest");
  if (typeof manifestRaw !== "string") throw new ValidationError("缺少 manifest");
  const manifest = parseManifest(manifestRaw);

  // 同名 `files` 字段可能混入字符串条目，丢弃后由下一行的数量校验报错，避免把字符串当文件读。
  const files = formData.getAll("files").filter((item) => typeof item !== "string");
  if (manifest.length !== files.length) throw new ValidationError("上传文件与 manifest 数量不一致");

  const uploadFiles = await Promise.all(
    manifest.map(async (entry, index) => ({
      skillName: entry.skillName,
      relativePath: entry.relativePath,
      content: await files[index].text(),
    })),
  );
  return { files: uploadFiles, formData };
}
