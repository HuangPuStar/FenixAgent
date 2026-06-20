/**
 * Salmon index 构建 — 一次性参考基因组索引构建（PE RNA-Seq 预处理）。
 *
 * 仅在第一次跑流程或换 reference 时需要，不必每次跑流程都执行。
 * 默认 yaml 工作流不含此节点，用户可在 yaml 中按需加入（depends_on: []）。
 *
 * 关键修复（design.md §5.3）：必须 --gencode 构建，否则与 GTF 版本不匹配，
 * 产生 19MB 无害 warning 日志。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class BuildSalmonIndexNode extends SlurmNode {
  name = "build_salmon_index";
  description = "Salmon 索引构建（--gencode，PE RNA-Seq 预处理，一次性）";

  inputs: Record<string, InputDef> = {
    transcriptome_fa: {
      type: "file",
      required: true,
      description: "转录组 FASTA（cDNA），如 Mus_musculus.GRCm39.cdna.all.fa",
    },
    output_index: {
      type: "string",
      required: true,
      description: "Salmon 索引输出目录（绝对路径）",
    },
  };

  produces = ["index_dir"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 16,
    memory: "50G",
    walltime: "02:00:00",
    modules: ["apps/apptainer/1.2.4"],
  };

  buildScript(ctx: ExecuteContext): string {
    const fa = String(ctx.inputs.transcriptome_fa);
    const outIndex = String(ctx.inputs.output_index);
    const sif = String(ctx.params.sif);
    const bind = String(ctx.params.apptainer_bind ?? "/work/home:/work/home");
    const cores = this.slurmConfig.cores;

    return [
      `echo "=== Building salmon index (--gencode) ==="`,
      `echo "Started at: $(date)"`,
      `mkdir -p ${outIndex}`,
      `apptainer exec --bind ${bind} ${sif} \\`,
      `  salmon index \\`,
      `    -t ${fa} \\`,
      `    -i ${outIndex} \\`,
      `    --gencode \\`,
      `    -p ${cores}`,
      "",
      "# 输出校验",
      `test -d ${outIndex} || { echo "ERROR: ${outIndex} missing" >&2; exit 1; }`,
      `test -s ${outIndex}/versionInfo.json || { echo "ERROR: ${outIndex}/versionInfo.json missing" >&2; exit 1; }`,
      `echo "{\\"index_dir\\":\\"${outIndex}\\",\\"size\\":\\"$(du -sh ${outIndex} | cut -f1)\\"}"`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
