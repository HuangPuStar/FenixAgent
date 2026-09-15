import { extname, resolve } from "node:path";
import { type AssemblyProfile, parseAssemblyProfile } from "@fenix/platform-sdk/assembly";

/** CE 发布入口固定的默认 assembly profile，不接受 profile 内反向指定路径。 */
export const CE_ASSEMBLY_PROFILE_PATH = resolve(import.meta.dir, "../../../deploy/assembly/ce.json");

/** 从发布入口选定的 JSON/YAML 文件读取并校验通用 assembly profile。 */
export async function loadAssemblyProfile(profilePath = CE_ASSEMBLY_PROFILE_PATH): Promise<AssemblyProfile> {
  const extension = extname(profilePath).toLowerCase();
  if (extension !== ".json" && extension !== ".yaml" && extension !== ".yml") {
    throw new Error("assembly profile 仅支持 .json、.yaml 或 .yml");
  }

  const source = await Bun.file(profilePath).text();
  const rawProfile: unknown = extension === ".json" ? JSON.parse(source) : Bun.YAML.parse(source);
  return parseAssemblyProfile(rawProfile);
}
