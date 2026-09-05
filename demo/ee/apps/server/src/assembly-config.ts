import { parseAssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import rawAssemblyConfig from "../../../deploy/assembly/ee.json";

/** EE 只负责加载自己的 profile；模块语义在 EE app 对 registry 校验。 */
export const eeAssemblyConfig = parseAssemblyProfile(rawAssemblyConfig);
