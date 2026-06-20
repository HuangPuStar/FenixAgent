/**
 * Flatten collection — Galaxy 内部列表整理步骤的占位节点（PE RNA-Seq 步骤 ⑤）。
 *
 * 原始 Galaxy 步骤仅做集合数据结构转换（paired → flat），RCS 工作流不维护中间集合，
 * 因此本节点退化为 no-op echo ok，仅保留 DAG 拓扑节点方便与 Galaxy 流程对照。
 *
 * 不需要 apptainer，不投计算节点（cores=1，walltime 极短）。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class FlattenNode extends SlurmNode {
  name = "flatten";
  description = "Flatten collection（Galaxy 占位步骤，no-op echo ok）";

  inputs: Record<string, InputDef> = {
    sample_id: { type: "string", required: true, description: "样本 ID（仅用于日志标识）" },
  };

  produces = ["ok"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 1,
    walltime: "00:10:00",
  };

  buildScript(ctx: ExecuteContext): string {
    const sampleId = String(ctx.inputs.sample_id);
    return [
      `echo "=== Flatten collection - ${sampleId} ==="`,
      `echo "Started at: $(date)"`,
      `echo ok`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
