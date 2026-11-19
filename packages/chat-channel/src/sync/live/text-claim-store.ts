import type { ProjectionStore } from "../store/types";

/** canonical 与连续 tail 的只读端口，读取器不能借用提交或租约能力。 */
export type TextClaimReadStore = Readonly<
  Pick<ProjectionStore, "readSuccessor" | "readDocStateAt" | "readUpdatesAfter">
>;

/** 幂等声明只依赖已提交身份、谱系和正文，不持有完整 Store 的写入面。 */
export type TextClaimStore = TextClaimReadStore &
  Readonly<Pick<ProjectionStore, "readGeneration" | "locateRefs" | "readLiveTextCoverage">>;
