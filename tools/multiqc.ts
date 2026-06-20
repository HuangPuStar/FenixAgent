/**
 * MultiQC — 全流程质控报告汇总（PE RNA-Seq 步骤 ⑩）。
 *
 * 扫描 step_4/step_6/step_7/step_8/step_9 各目录的统计文件，
 * 生成单一 HTML 报告。
 *
 * 关键经验（design.md §5.5）：精确指定扫描目录，避免纳入历史残留。
 */
import type { ExecuteContext, InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class MultiqcNode extends SlurmNode {
  name = "multiqc";
  description = "MultiQC 全流程质控汇总（PE RNA-Seq 步骤 ⑩）";

  inputs: Record<string, InputDef> = {
    // 多个扫描目录，逗号分隔。MultiQC 自动识别子模块（FastQC/Salmon/STAR/featureCounts）
    scan_dirs: {
      type: "string",
      required: true,
      description: "扫描目录列表，逗号分隔（建议精确到 step_N 子目录）",
    },
    output_dir: { type: "string", required: true, description: "报告输出目录" },
    title: { type: "string", required: false, description: "报告标题（默认 'PE RNA-Seq Report'）" },
  };

  produces = ["report"];

  slurmConfig = {
    partition: "xahcnormal",
    cores: 8,
    walltime: "01:00:00",
    modules: ["apps/apptainer/1.2.4"],
  };

  buildScript(ctx: ExecuteContext): string {
    const scanDirsRaw = String(ctx.inputs.scan_dirs);
    const outDir = String(ctx.inputs.output_dir);
    const title = ctx.inputs.title ? String(ctx.inputs.title) : "PE RNA-Seq Report";
    const sif = String(ctx.params.sif);
    const bind = String(ctx.params.apptainer_bind ?? "/work/home:/work/home");

    // MultiQC 用 --title "带空格的标题" 时，输出文件名中空格会变 -
    const safeTitle = title.replace(/\s+/g, " ").trim();

    const scanDirs = scanDirsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return [
      `echo "=== MultiQC ==="`,
      `echo "Started at: $(date)"`,
      `mkdir -p ${outDir}`,
      `apptainer exec --bind ${bind} ${sif} \\`,
      `  multiqc \\`,
      `    ${scanDirs.join(" ")} \\`,
      `    --outdir ${outDir} \\`,
      `    --title "${safeTitle}"`,
      "",
      "# 输出校验（MultiQC 会把标题中的空格替换为 -，拼接文件名）",
      `REPORT_TITLE="${safeTitle.replace(/\s+/g, "-")}"`,
      `REPORT="${outDir}/\${REPORT_TITLE}_multiqc_report.html"`,
      `test -s "$REPORT" || { echo "ERROR: $REPORT missing or empty" >&2; exit 1; }`,
      `echo "{\\"report\\":\\"$REPORT\\",\\"size\\":\\"$(du -h \\"$REPORT\\" | cut -f1)\\"}"`,
      `echo "Finished at: $(date)"`,
    ].join("\n");
  }
}
