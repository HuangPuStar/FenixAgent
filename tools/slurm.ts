/**
 * 通用 Slurm 工具 — 唯一的 custom tool，所有 HPC 作业统一走它。
 *
 * 设计哲学：工具层不耦合任何业务（不再为 trim_galore / salmon / star 等单独写 TS 子类）。
 * 脚本内容由 YAML 节点的 `inputs.script` 注入，Slurm 资源由 YAML 节点的 `slurm:` 字段声明，
 * 引擎通过 ${{ }} 表达式把 params / 上游 outputs 求值后拼进脚本。
 *
 * 一个节点 = 一段 bash 脚本 + 一组资源声明，引擎不再关心脚本里跑的是什么工具。
 *
 * YAML 示例：
 *   - id: trim_galore
 *     type: custom
 *     tool: slurm
 *     slurm:
 *       partition: xahcnormal
 *       cores: 4
 *       walltime: "02:00:00"
 *       modules: ["apps/apptainer/1.2.4"]
 *     inputs:
 *       script: |
 *         apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
 *           trim_galore --paired --cores 4 ...
 *     outputs:
 *       trimmed_r1:
 *         pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
 *         type: file
 */
import type { InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class SlurmToolNode extends SlurmNode {
  name = "slurm";
  description = "通用 Slurm HPC 作业执行器：脚本内容由 inputs.script 注入，资源由 slurm 字段声明";

  inputs: Record<string, InputDef> = {
    /**
     * sbatch 脚本正文（bash）。支持 ${{ params.xxx }} / ${{ nodes.X.outputs.Y }} 表达式，
     * 引擎 inputs-resolver 会先求值再传给 SlurmNode.buildScript()。
     * 脚本里不要写 #SBATCH 指令，header 由 SlurmNode.generateHeader 根据 slurm 字段生成。
     */
    script: {
      type: "string",
      required: true,
      description: "bash 脚本正文。支持 ${{ }} 表达式；#SBATCH 指令由引擎按 slurm 字段自动生成，请勿在此重复声明",
    },
  };

  /**
   * 通配符 outputs：YAML 节点可声明任意 outputs key（trimmed_r1 / bam / quant_sf / ...），
   * 引擎跳过严格 produces 校验，由用户在 YAML 自行保证 pattern 真实存在。
   */
  produces = ["*"];
}
