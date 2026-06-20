/**
 * Salmon quant — 转录本级别的表达定量（PE RNA-Seq 步骤 ⑥）。
 *
 * 输入 Trim Galore 的 val_{1,2}.fq.gz + salmon 索引，输出 quant.sf（表达矩阵）。
 *
 * 关键参数（与 design.md §5.2 对齐）：
 * - --libType IU：显式指定反转录入库（mouse RNA-Seq 常见类型）
 * - --validateMappings：开启 SMEM 校验映射，提升准确度
 * - --numBootstraps 30：bootstrap 30 次，用于下游 tximport 置信区间估计
 * - --threads 与 SBATCH cpus 对齐
 *
 * Salmon index 必须 --gencode 构建（避免版本不匹配导致 19MB warning，见 design.md §5.3）。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class SalmonQuantNode extends SlurmNode {
  name = "salmon_quant";
  description = "Salmon quant 转录本表达定量（PE RNA-Seq 步骤 ⑥）";

  inputs: Record<string, InputDef> = {
    r1: { type: "file", required: true, description: "Trim Galore 后 Read 1（*_1_val_1.fq.gz）" },
    r2: { type: "file", required: true, description: "Trim Galore 后 Read 2（*_2_val_2.fq.gz）" },
    index: { type: "string", required: true, description: "Salmon 索引目录（--gencode 构建）" },
    output_dir: { type: "string", required: true, description: "输出目录（quant.sf 所在目录）" },
  };

  produces = ["quant_sf"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 8,
    walltime: "02:00:00",
    modules: ["apps/apptainer/1.2.4"],
  };

  buildScript(ctx: ExecuteContext): string {
    const r1 = String(ctx.inputs.r1);
    const r2 = String(ctx.inputs.r2);
    const index = String(ctx.inputs.index);
    const outDir = String(ctx.inputs.output_dir);
    const sif = String(ctx.params.sif);
    const bind = String(ctx.params.apptainer_bind ?? "/work/home:/work/home");
    const cores = this.slurmConfig.cores;

    return [
      `echo "=== Salmon quant ==="`,
      `echo "Started at: $(date)"`,
      `mkdir -p ${outDir}`,
      `apptainer exec --bind ${bind} ${sif} \\`,
      `  salmon quant \\`,
      `    --index ${index} \\`,
      `    --libType IU \\`,
      `    --mates1 ${r1} \\`,
      `    --mates2 ${r2} \\`,
      `    --output ${outDir} \\`,
      `    --numBootstraps 30 \\`,
      `    --validateMappings \\`,
      `    --threads ${cores}`,
      "",
      "# 输出校验",
      `QUANT_SF="${outDir}/quant.sf"`,
      `test -s "$QUANT_SF" || { echo "ERROR: $QUANT_SF missing or empty" >&2; exit 1; }`,
      `echo "{\\"quant_sf\\":\\"$QUANT_SF\\",\\"transcripts\\":$(wc -l < "$QUANT_SF")}"`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
