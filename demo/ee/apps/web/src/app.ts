import type { AgentConfigWebContribution } from "@fenix-ce/agent-config/web";
import { createModuleRegistry, type WebShell } from "@fenix-ce/platform-sdk";
import { type AssemblyProfile, parseAssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import rawAssemblyConfig from "../../../deploy/assembly/ee.json";
import { generatedModuleManifests } from "../../generated/module-registry";
import { enterpriseAppShell } from "./shell/enterprise-app-shell";

type EeWebAssemblyConfig = Pick<AssemblyProfile, "webShell" | "web">;

/** EE web 使用构建期收集的 EE/CE contribution，不维护手写模块映射。 */
const moduleRegistry = createModuleRegistry(generatedModuleManifests);

/** EE 选择自己的完整壳；CE 壳不会成为企业全局 UI 的隐式父类。 */
function selectEeWebShell(shellId: string): WebShell {
  if (shellId !== enterpriseAppShell.id) throw new Error(`EE 不提供 Web Shell: ${shellId}`);
  return enterpriseAppShell;
}

/** EE web 壳按部署配置选择 EE 页面，不修改 CE submodule。 */
export function assembleEeWeb(config: EeWebAssemblyConfig) {
  return {
    edition: "ee",
    shell: selectEeWebShell(config.webShell),
    routes: config.web.map((moduleId) => moduleRegistry.requireWeb<AgentConfigWebContribution>(moduleId)),
  };
}

export const eeWebApp = assembleEeWeb(parseAssemblyProfile(rawAssemblyConfig));
