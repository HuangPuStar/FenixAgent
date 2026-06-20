/**
 * RNA STAR — 基因组比对，生成排序后的 BAM（PE RNA-Seq 步骤 ⑦）。
 *
 * 关键修复（验证报告记录 STAR 重试 2 次后成功）：
 * - --outTmpDir 指向 per-sample 独立目录，避免并行竞态
 * - --limitBAMsortRAM 40000000000（40GB），避免 BAM 排序阶段内存不足
 * - --mem=100G，与 limitBAMsortRAM 匹配，避免 OOM Killer
 * - preCleanup() 在 sbatch 前清理上次残留 tmp，避免 "could not make temporary directory"
 *
 * 输出 BAM 命名固定为 Aligned.sortedByCoord.out.bam（STAR 不可改）。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class RnaStarNode extends SlurmNode {
  name = "rna_star";
  description = "RNA STAR 基因组比对，输出排序 BAM（PE RNA-Seq 步骤 ⑦）";

  inputs: Record<string, InputDef> = {
    r1: { type: "file", required: true, description: "Trim Galore 后 Read 1（*_1_val_1.fq.gz）" },
    r2: { type: "file", required: true, description: "Trim Galore 后 Read 2（*_2_val_2.fq.gz）" },
    genome_dir: { type: "string", required: true, description: "STAR genome 索引目录" },
    // 末尾必须带 /，STAR 拼接文件名时不补 /，否则会变成 xxxSAMPLEAligned.*
    output_prefix: {
      type: "string",
      required: true,
      description: "STAR 输出前缀（目录必须以 / 结尾）",
    },
  };

  produces = ["bam"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 32,
    memory: "100G",
    walltime: "04:00:00",
    modules: ["apps/apptainer/1.2.4"],
  };

  // BAM 排序磁盘空间大，按 limitBAMsortRAM 40G 评估，重试也避免 OOM 死循环
  maxRetries = 1;
  retryDelay = 30000;

  /** sbatch 前清理上次残留 tmp（避免 STAR "could not make temporary directory"） */
  preCleanup(ctx: ExecuteContext): string {
    const prefix = String(ctx.inputs.output_prefix);
    return `rm -rf ${prefix}tmp`;
  }

  buildScript(ctx: ExecuteContext): string {
    const r1 = String(ctx.inputs.r1);
    const r2 = String(ctx.inputs.r2);
    const genomeDir = String(ctx.inputs.genome_dir);
    const prefix = String(ctx.inputs.output_prefix);
    const sif = String(ctx.params.sif);
    const bind = String(ctx.params.apptainer_bind ?? "/work/home:/work/home");
    const cores = this.slurmConfig.cores;
    const tmpDir = `${prefix}tmp`;

    return [
      `echo "=== RNA STAR ==="`,
      `echo "Started at: $(date)"`,
      // prefix 通常是 .../step_7/{sample}/，其父目录需要存在；tmp 单独创建
      `mkdir -p ${prefix} ${tmpDir}`,
      `apptainer exec --bind ${bind} ${sif} \\`,
      `  STAR --runThreadN ${cores} \\`,
      `    --genomeDir ${genomeDir} \\`,
      `    --readFilesIn ${r1} ${r2} \\`,
      `    --readFilesCommand zcat \\`,
      `    --outFileNamePrefix ${prefix} \\`,
      `    --outTmpDir ${tmpDir} \\`,
      `    --limitBAMsortRAM 40000000000 \\`,
      `    --outSAMtype BAM SortedByCoordinate \\`,
      `    --outSAMattributes NH HI AS nM ch`,
      `# 清理 STAR 临时文件（BAM 已写完）`,
      `rm -rf ${tmpDir}`,
      "",
      "# 输出校验",
      `BAM_OUT="${prefix}Aligned.sortedByCoord.out.bam"`,
      `test -s "$BAM_OUT" || { echo "ERROR: $BAM_OUT missing or empty" >&2; exit 1; }`,
      `echo "{\\"bam\\":\\"$BAM_OUT\\",\\"size\\":\\"$(du -h \\"$BAM_OUT\\" | cut -f1)\\"}"`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
