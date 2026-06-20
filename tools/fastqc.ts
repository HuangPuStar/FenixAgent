/**
 * FastQC — FASTQ 质控报告生成（PE RNA-Seq 步骤 ⑧）。
 *
 * 在 Galaxy 流程中是 Reduce 节点（汇总所有样本的 FASTQ），单样本简化后接受一对 R1/R2。
 * 多样本场景下，可在 yaml 把多对 FASTQ 通过 input_files CSV 传入（fastqc 自身支持批量）。
 *
 * 输出：*.html 报告 + *_fastqc.zip 原始数据，落在 output_dir。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class FastqcNode extends SlurmNode {
  name = "fastqc";
  description = "FastQC FASTQ 质控报告（PE RNA-Seq 步骤 ⑧）";

  inputs: Record<string, InputDef> = {
    // 多样本场景下，yaml 可传 "r1,r1,r1" 形式，节点按逗号展开
    input_files: {
      type: "file-list",
      required: true,
      description: "FastQC 输入文件列表，逗号分隔（多样本时合并）",
    },
    output_dir: { type: "string", required: true, description: "报告输出目录" },
  };

  produces = ["report_dir"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 32,
    walltime: "02:00:00",
    modules: ["apps/apptainer/1.2.4"],
  };

  buildScript(ctx: ExecuteContext): string {
    const rawFiles = String(ctx.inputs.input_files);
    const outDir = String(ctx.inputs.output_dir);
    const sif = String(ctx.params.sif);
    const bind = String(ctx.params.apptainer_bind ?? "/work/home:/work/home");
    const cores = this.slurmConfig.cores;

    // CSV → bash 数组，兼容单样本/多样本场景
    const files = rawFiles
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return [
      `echo "=== FastQC - ${files.length} file(s) ==="`,
      `echo "Started at: $(date)"`,
      `mkdir -p ${outDir}`,
      `apptainer exec --bind ${bind} ${sif} \\`,
      `  fastqc --outdir ${outDir} --threads ${cores} \\`,
      `    ${files.join(" ")}`,
      "",
      "# 输出校验",
      `REPORT_COUNT=$(ls ${outDir}/*.html 2>/dev/null | wc -l)`,
      `if [ "$REPORT_COUNT" -eq 0 ]; then`,
      `  echo "ERROR: no FastQC html report generated in ${outDir}" >&2`,
      `  exit 1`,
      `fi`,
      `echo "{\\"report_dir\\":\\"${outDir}\\",\\"reports\\":$REPORT_COUNT}"`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
