/** 内存缓存字段只允许 adapter 计算，协议输入、导出和恢复边界统一剥离。 */
export function stripDerivedMemoryState<T extends object>(value: T) {
  const {
    contentUsage: _usage,
    textCoverage: _coverage,
    textCoverageRevision: _revision,
    ...portable
  } = value as T & {
    contentUsage?: unknown;
    textCoverage?: unknown;
    textCoverageRevision?: unknown;
  };
  return portable;
}
