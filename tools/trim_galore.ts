/**
 * Trim Galore — PE FASTQ 接头切除 + 质量过滤（PE RNA-Seq 流程步骤 ④）。
 *
 * 输入一对 FASTQ（R1/R2），输出去接头后的 *_val_{1,2}.fq.gz。
 * Slurm 资源：4 cores（trim_galore 多线程能力有限），单样本约 8 分钟。
 *
 * 上游：直接从 params 读取原始 FASTQ 路径（数据输入节点）。
 * 下游：salmon_quant / rna_star / fastqc 共同消费 step_4 产物。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class TrimGaloreNode extends SlurmNode {
  name = "trim_galore";
  description = "Trim Galore! PE FASTQ 接头切除与质控（PE RNA-Seq 步骤 ④）";

  inputs: Record<string, InputDef> = {
    r1: { type: "file", required: true, description: "Read 1 FASTQ 路径（集群绝对路径）" },
    r2: { type: "file", required: true, description: "Read 2 FASTQ 路径（集群绝对路径）" },
    output_dir: { type: "string", required: true, description: "输出目录（集群绝对路径）" },
    sample_id: { type: "string", required: true, description: "样本 ID，用于命名 *_val_*.fq.gz" },
  };

  produces = ["trimmed_r1", "trimmed_r2"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 4,
    walltime: "02:00:00",
    modules: ["apps/apptainer/1.2.4"],
  };

  buildScript(ctx: ExecuteContext): string {
    // 所有路径参数已在 yaml inputs 中显式注入；sif / bind 走全局 params
    const r1 = String(ctx.inputs.r1);
    const r2 = String(ctx.inputs.r2);
    const outDir = String(ctx.inputs.output_dir);
    const sampleId = String(ctx.inputs.sample_id);
    const sif = String(ctx.params.sif);
    // bind 默认 /work/home:/work/home，覆盖所有子目录；用户可在 yaml params 覆盖
    const bind = String(ctx.params.apptainer_bind ?? "/work/home:/work/home");
    const cores = this.slurmConfig.cores;

    return [
      `echo "=== Trim Galore - ${sampleId} ==="`,
      `mkdir -p ${outDir}`,
      // apptainer 调用，--cores 与 SBATCH cpus 对齐避免资源浪费
      `apptainer exec --bind ${bind} ${sif} \\`,
      `  trim_galore --paired --cores ${cores} --output_dir ${outDir} --gzip ${r1} ${r2}`,
      "",
      "# 输出校验：trim_galore 命名规则为 {sample}_1_val_1.fq.gz / {sample}_2_val_2.fq.gz",
      `R1_OUT="${outDir}/${sampleId}_1_val_1.fq.gz"`,
      `R2_OUT="${outDir}/${sampleId}_2_val_2.fq.gz"`,
      `test -s "$R1_OUT" || { echo "ERROR: $R1_OUT missing or empty" >&2; exit 1; }`,
      `test -s "$R2_OUT" || { echo "ERROR: $R2_OUT missing or empty" >&2; exit 1; }`,
      // JSON 输出，便于下游通过 nodes.trim_galore.output.trimmed_r1 引用
      `echo "{\\"trimmed_r1\\":\\"$R1_OUT\\",\\"trimmed_r2\\":\\"$R2_OUT\\",\\"sample_id\\":\\"${sampleId}\\"}"`,
    ].join("\n");
  }
}
