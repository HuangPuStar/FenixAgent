/**
 * Trace 观测模块的运行时表面。
 *
 * 本模块没有进程内状态：读取链路的每次请求都按当前模块配置新建薄客户端，没有一个需要「对象身份」的注册表
 * 或缓存（见 `./server/services/trace-read`）。因此实例只承载模块身份，供装配面在日志与健康检查里指认。
 */
export interface TraceModule {
  readonly id: "trace";
}

/** 创建 Trace 模块实例。 */
export function createTraceModule(): TraceModule {
  return { id: "trace" };
}
