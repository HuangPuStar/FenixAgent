/**
 * 通用 Slurm 工具 — 唯一的 custom tool,所有 HPC 作业统一走它。
 *
 * 设计哲学:工具层不耦合任何业务(不再为 trim_galore / salmon / star 等单独写 TS 子类)。
 * 脚本内容由 YAML 节点的 `script.content` 注入,环境变量由 `script.env` 声明,
 * Slurm 资源由 YAML 节点的 `slurm:` 字段声明,
 * 引擎通过 ${{ }} 表达式把 params / 上游 outputs 求值后拼进脚本。
 *
 * 一个节点 = 一段 bash 脚本 + 一组资源声明,引擎不再关心脚本里跑的是什么工具。
 *
 * YAML 示例:
 *   - id: trim_galore
 *     type: custom
 *     tool: slurm
 *     slurm:
 *       partition: xahcnormal
 *       cores: 4
 *       walltime: "02:00:00"
 *       modules: ["apps/apptainer/1.2.4"]
 *     script:
 *       content: |
 *         apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
 *           trim_galore --paired --cores 4 ...
 *       env:
 *         WORK_DIR: ${{ params.work_dir }}
 *     outputs:
 *       trimmed_r1:
 *         pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
 *         type: file
 */
import type { InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class SlurmToolNode extends SlurmNode {
  name = "slurm";
  description = "通用 Slurm HPC 作业执行器:脚本内容由 script.content 注入,资源由 slurm 字段声明";

  // inputs 为空对象 — 通用 slurm 工具不声明任何 input 字段
  // 脚本内容由节点级 script.content 提供(由 SlurmNode.buildScript 默认实现读取)
  // YAML 用户如需声明上游数据绑定(用于前端连线),仍可在节点 inputs 里写字段,
  // 但通用工具不消费它们
  inputs: Record<string, InputDef> = {};

  /**
   * 通配符 outputs:YAML 节点可声明任意 outputs key(trimmed_r1 / bam / quant_sf / ...),
   * 引擎跳过严格 produces 校验,由用户在 YAML 自行保证 pattern 真实存在。
   */
  produces = ["*"];

  /** Slurm 作业节点颜色 — 深靛蓝 */
  color = "#4f46e5";

  /**
   * Slurm 作业运行时依赖的环境变量。
   * 引擎通过 SecretsResolver 解析，集群连接信息等可从环境注入。
   */
  env: string[] = [];
}
