/**
 * Column Join — featureCounts 结果按列汇总（PE RNA-Seq 步骤 ⑪）。
 *
 * 原始 Galaxy 流程的 "Column join" 操作：对每个 featureCounts 输出文件，
 * 抽取 gene_id 与 count 列，输出 *_counts.txt（去掉统计注释行）。
 *
 * 单样本场景下输出 1 个文件，多样本场景会自动遍历匹配 pattern 的所有文件。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class ColumnJoinNode extends SlurmNode {
  name = "column_join";
  description = "featureCounts 结果列汇总（PE RNA-Seq 步骤 ⑪）";

  inputs: Record<string, InputDef> = {
    input_dir: { type: "string", required: true, description: "featureCounts 输出目录（step_9）" },
    output_dir: { type: "string", required: true, description: "汇总输出目录（step_11）" },
    // 默认 SRR*.txt 只匹配样本输出，排除 featureCounts 副产物（如 *.summary）
    pattern: {
      type: "string",
      required: false,
      description: "文件 glob 模式（默认 SRR*.txt）",
    },
  };

  produces = ["joined_dir"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 1,
    walltime: "00:30:00",
  };

  buildScript(ctx: ExecuteContext): string {
    const inDir = String(ctx.inputs.input_dir);
    const outDir = String(ctx.inputs.output_dir);
    const pattern = ctx.inputs.pattern ? String(ctx.inputs.pattern) : "SRR*.txt";

    return [
      `echo "=== Column Join (featureCounts 结果汇总) ==="`,
      `echo "Started at: $(date)"`,
      `mkdir -p ${outDir}`,
      `PROCESSED=0`,
      // cut -f 1,7：gene_id 列 + Assigned 列（featureCounts 第 7 列是计数）
      `for f in ${inDir}/${pattern}; do`,
      `  if [ -f "$f" ]; then`,
      `    base=$(basename "$f")`,
      `    cut -f 1,7 "$f" > ${outDir}/"$base"_counts.txt`,
      `    PROCESSED=$((PROCESSED + 1))`,
      `  fi`,
      `done`,
      `if [ "$PROCESSED" -eq 0 ]; then`,
      `  echo "ERROR: No featureCounts output files found in ${inDir}/${pattern}" >&2`,
      `  exit 1`,
      `fi`,
      `echo "{\\"joined_dir\\":\\"${outDir}\\",\\"files\\":$PROCESSED}"`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
