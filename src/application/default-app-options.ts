import type { Logger } from "@fenix/logger";
import type { AppConfig } from "../config";
import type { Env } from "../env";

/** 社区默认应用装配所需的宿主参数。 */
export interface DefaultApplicationOptions {
  readonly env: Env;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly startedAt: string;
}
