/**
 * Instance 子域的公开类型。
 *
 * `InstanceInfo` 与 `InstanceStatus` 已在 `types/domain.ts`（I1）中定义，
 * 此处 re-export 保持子域入口一致，避免两处定义漂移。
 */

import type { InstanceInfo, InstanceStatus } from "../types/domain";

export type { InstanceInfo, InstanceStatus };
