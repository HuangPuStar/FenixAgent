import type { AgentConfigWebContribution } from "@fenix-ce/agent-config/web";
import { createModuleRegistry, type WebShell } from "@fenix-ce/platform-sdk";
import { type AssemblyProfile, parseAssemblyProfile } from "@fenix-ce/platform-sdk/assembly";
import rawAssemblyConfig from "../../../deploy/assembly/ce.json";
import { generatedModuleManifests } from "../../generated/module-registry";
import { communityAppShell } from "./shell/community-app-shell";

type CeWebAssemblyConfig = Pick<AssemblyProfile, "webShell" | "web">;

/** 构建期生成的 registry 同时为 web 提供可用 contribution 集合。 */
const moduleRegistry = createModuleRegistry(generatedModuleManifests);

/** app 自己拥有 CE 壳；profile 必须明确选择该壳，避免资源 contribution 决定全局布局。 */
function selectCeWebShell(shellId: string): WebShell {
  if (shellId !== communityAppShell.id) throw new Error(`CE 不提供 Web Shell: ${shellId}`);
  return communityAppShell;
}

/** web 应用壳只选择模块页面；demo 页面为空，不引入 React。 */
export function assembleCeWeb(config: CeWebAssemblyConfig) {
  return {
    edition: "ce",
    shell: selectCeWebShell(config.webShell),
    routes: config.web.map((moduleId) => moduleRegistry.requireWeb<AgentConfigWebContribution>(moduleId)),
  };
}

/** 与 server 使用同一个部署配置，但 web 仅消费已经编译进 bundle 的 contribution。 */
export const ceWebApp = assembleCeWeb(parseAssemblyProfile(rawAssemblyConfig));
