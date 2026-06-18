/**
 * 自定义节点插件系统 — 核心类型定义。
 *
 * 定义 CustomNode（工具合约）、InputDef（输入声明）、ExecuteContext（运行时上下文）。
 * 这些类型被 CustomNodeRegistry 和 CustomNodeExecutor 共同依赖。
 */

import type { z } from "zod/v4";
import type { StorageAdapter } from "../storage/storage-adapter";
import type { NodeOutput } from "../types/execution";

/** 输入字段声明 */
export interface InputDef {
  /** 字段类型，前端据此渲染 input handle */
  type: "string" | "number" | "boolean" | "file" | "file-list";
  /** 是否必填，默认 true */
  required?: boolean;
  /** 字段描述，前端 tooltip */
  description: string;
  /** Zod 校验 schema。引擎在 inputs 表达式求值后、execute() 调用前执行校验 */
  validate?: z.ZodType;
}

/** 自定义节点插件接口 — 所有工具的基类 */
export interface CustomNode {
  /** 工具唯一名称，YAML 中通过 tool 字段引用 */
  name: string;

  /** 工具描述，前端卡片展示 + tooltip */
  description: string;

  /** 输入字段声明 */
  inputs: Record<string, InputDef>;

  /** 输出字段名列表。具体的文件路径 pattern 在 YAML 的 CustomNodeDef.outputs 中声明 */
  produces: string[];

  /** 核心执行方法。引擎可能在 foreach 场景下调多次，每次处理一个迭代单元 */
  execute(ctx: ExecuteContext): Promise<NodeOutput>;

  /**
   * 清理钩子（可选）。execute() 之后必定调用，无论成功失败。
   * 用于清理临时文件、释放远程连接等。
   * 结果和错误可能同时为 null（execute 抛非预期异常时）。
   */
  onCleanup?(ctx: ExecuteContext, result: NodeOutput | null, error: Error | null): Promise<void>;
}

/** 执行上下文 — 引擎传递给每个 custom node 的运行时信息 */
export interface ExecuteContext {
  /** 已求值的输入值，key 对应 CustomNode.inputs 的 key */
  inputs: Record<string, unknown>;

  /** 工作流级 params */
  params: Record<string, unknown>;

  /** 工作流级 secrets */
  secrets: Record<string, string>;

  /** 工作目录根路径 */
  workDir: string;

  /** 取消信号，引擎 cancel 时 AbortController.abort() */
  signal: AbortSignal;

  /** 存储适配器（写事件/输出） */
  storage: StorageAdapter;

  /** 运行 ID */
  runId: string;

  /** 节点 ID */
  nodeId: string;

  /**
   * foreach 迭代上下文。
   * 非 Map 节点为 null。Map 节点引擎自动展开，每次 execute() 注入当前迭代元素。
   */
  foreach?: {
    item: Record<string, unknown>;
    index: number;
  };
}
