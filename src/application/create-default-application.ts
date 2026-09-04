import { ApplicationBuilder } from "@fenix/server-runtime";
import { createCommunityBaseApp } from "./base-app";
import type { DefaultApplicationOptions } from "./default-app-options";
import { createCommunityDefaultProfile } from "./default-profile";

/** 构造社区默认应用及其生命周期句柄，不启动外部资源。 */
export function createDefaultApplication(options: DefaultApplicationOptions) {
  const profile = createCommunityDefaultProfile(options);
  const builder = ApplicationBuilder.create({
    profileName: profile.name,
    createBaseApp: () => createCommunityBaseApp(options),
  });
  return profile.configure(builder).build();
}

/** 社区默认应用运行句柄。 */
export type DefaultApplicationRuntime = ReturnType<typeof createDefaultApplication>;

/** 社区默认 Elysia 应用类型。 */
export type App = DefaultApplicationRuntime["app"];
