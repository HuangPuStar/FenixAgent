/** 内存缓存字段只允许 adapter 计算，协议输入、导出和恢复边界统一剥离。 */
export function stripDerivedMemoryState<T extends object>(value: T) {
  const {
    [WORKING_CREDIT]: _credit,
    contentUsage: _usage,
    encodedStateBound: _encoded,
    textCoverage: _coverage,
    textCoverageRevision: _revision,
    ...portable
  } = value as T & {
    [WORKING_CREDIT]?: unknown;
    contentUsage?: unknown;
    encodedStateBound?: unknown;
    textCoverage?: unknown;
    textCoverageRevision?: unknown;
  };
  return portable;
}

import { WORKING_CREDIT } from "../capacity/working-credit";
