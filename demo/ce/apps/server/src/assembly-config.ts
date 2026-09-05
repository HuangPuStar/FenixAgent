import { parseAssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import rawAssemblyConfig from "../../../deploy/assembly/ce.json";

/** CE 只负责加载自己的 profile；profile 的通用结构由公开 SDK 校验。 */
export const ceAssemblyConfig = parseAssemblyProfile(rawAssemblyConfig);
