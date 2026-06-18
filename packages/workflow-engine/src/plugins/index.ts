/**
 * plugins/ — 自定义节点插件系统导出。
 */

export { CustomNodeExecutor } from "./custom-executor";
export { CustomNodeRegistry } from "./registry";
export { BunSshExecutor, mapSlurmState, SlurmNode } from "./slurm-node";
export type { JobResult, SlurmConfig, SshExecutor } from "./slurm-types";
export type { CustomNode, ExecuteContext, InputDef } from "./types";
