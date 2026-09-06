import type { ApplicationBuilder, ApplicationProfile } from "@fenix/server-runtime";
import type { createCommunityBaseApp } from "./base-app";
import type { DefaultApplicationOptions } from "./default-app-options";
import { createLegacyCommunityModule } from "./modules/legacy-community-module";

type CommunityBaseApp = ReturnType<typeof createCommunityBaseApp>;

/** 创建保持社区版现有能力的默认模块 Profile。 */
export function createCommunityDefaultProfile(options: DefaultApplicationOptions) {
  const legacyCommunityModule = createLegacyCommunityModule(options);
  const configure = (builder: ApplicationBuilder<CommunityBaseApp>) => builder.use(legacyCommunityModule);

  return {
    name: "community-default",
    configure,
  } satisfies ApplicationProfile<CommunityBaseApp, ReturnType<typeof configure>>;
}

/** 社区默认应用 Profile。 */
export type CommunityDefaultProfile = ReturnType<typeof createCommunityDefaultProfile>;
