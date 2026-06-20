/**
 * featureCounts — 基因水平 read 计数（PE RNA-Seq 步骤 ⑨）。
 *
 * 输入 STAR 产出的 BAM + GTF 注释，输出每样本一个 counts.txt + .summary。
 *
 * 关键参数（design.md §5.2）：
 * - -t exon -g gene_id：标准外显子→基因聚合
 * - -p：paired-end 模式
 * - -s 0：unstranded（mouse RNA-Seq kit 默认）
 * - -Q 12：过滤 MAPQ<12 比对（ENCODE 标准），排除噪声
 * - --primary：仅统计 primary 比对，避免次级比对重复计数
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class FeaturecountsNode extends SlurmNode {
  name = "featurecounts";
  description = "featureCounts 基因水平 read 计数（PE RNA-Seq 步骤 ⑨）";

  inputs: Record<string, InputDef> = {
    bam: { type: "file", required: true, description: "STAR 输出的排序 BAM" },
    gtf: { type: "file", required: true, description: "基因组注释 GTF" },
    output_file: { type: "string", required: true, description: "counts 输出文件路径（含文件名）" },
  };

  produces = ["counts"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 8,
    walltime: "01:00:00",
    modules: ["apps/apptainer/1.2.4"],
  };

  buildScript(ctx: ExecuteContext): string {
    const bam = String(ctx.inputs.bam);
    const gtf = String(ctx.inputs.gtf);
    const outFile = String(ctx.inputs.output_file);
    const sif = String(ctx.params.sif);
    const bind = String(ctx.params.apptainer_bind ?? "/work/home:/work/home");
    const cores = this.slurmConfig.cores;

    return [
      `echo "=== featureCounts ==="`,
      `echo "Started at: $(date)"`,
      `mkdir -p $(dirname ${outFile})`,
      `apptainer exec --bind ${bind} ${sif} \\`,
      `  featureCounts \\`,
      `    -T ${cores} \\`,
      `    -a ${gtf} \\`,
      `    -o ${outFile} \\`,
      `    -t exon -g gene_id -p -s 0 -Q 12 --primary \\`,
      `    ${bam}`,
      "",
      "# 输出校验",
      `test -s "${outFile}" || { echo "ERROR: ${outFile} missing or empty" >&2; exit 1; }`,
      // 从 .summary 文件提取 Assigned 计数（featureCounts 自动生成同名 .summary）
      `SUMMARY="${outFile}.summary"`,
      `ASSIGNED=$(grep "^Assigned" "$SUMMARY" 2>/dev/null | cut -f2 || echo 0)`,
      `echo "{\\"counts\\":\\"${outFile}\\",\\"assigned\\":$ASSIGNED}"`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
