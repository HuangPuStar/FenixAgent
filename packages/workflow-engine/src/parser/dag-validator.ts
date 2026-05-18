/**
 * DAG 校验器 — 校验 WorkflowDef 的结构合法性
 *
 * 检查项：节点 ID 唯一性、环检测（Kahn 算法）、依赖存在性、
 * 自动扫描 ${{ }} 补充 depends_on、变量引用合法性。
 */

import type { NodeDef, WorkflowDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";

/** 校验问题 */
export interface ValidationIssue {
  type: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
}

/** 校验结果 */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** 深拷贝并增强后的 WorkflowDef（自动补充的 depends_on 等修改仅作用于此副本） */
  def: WorkflowDef;
}

/**
 * 校验 WorkflowDef 的 DAG 结构
 * @returns ValidationResult，包含校验结果、问题列表和增强后的定义副本
 * @throws WorkflowError(DUPLICATE_NODE_ID) 重复节点 ID（硬错误）
 */
export function validateDAG(input: WorkflowDef): ValidationResult {
  const def = structuredClone(input);
  const issues: ValidationIssue[] = [];

  // 1. 节点 ID 唯一性
  const idSet = new Set<string>();
  for (const node of def.nodes) {
    if (idSet.has(node.id)) {
      throw new WorkflowError(`Duplicate node ID: '${node.id}'`, WorkflowErrorCode.DUPLICATE_NODE_ID, {
        nodeId: node.id,
      });
    }
    idSet.add(node.id);
  }

  // 4. 自动扫描 ${{ }} 补充 depends_on（在依赖存在性检查之前执行）
  const nodeMap = new Map<string, NodeDef>();
  for (const node of def.nodes) {
    nodeMap.set(node.id, node);
  }
  for (const node of def.nodes) {
    const autoDeps = scanTemplateDeps(node);
    for (const depId of autoDeps) {
      if (!node.depends_on?.includes(depId)) {
        if (!node.depends_on) node.depends_on = [];
        node.depends_on.push(depId);
        issues.push({
          type: "warning",
          code: "AUTO_DEPENDENCY_ADDED",
          message: `Auto-added '${depId}' to depends_on of '${node.id}' (detected in template expression)`,
          nodeId: node.id,
        });
      }
    }
  }

  // 3. 依赖存在性
  for (const node of def.nodes) {
    if (node.depends_on) {
      for (const depId of node.depends_on) {
        if (!idSet.has(depId)) {
          issues.push({
            type: "error",
            code: WorkflowErrorCode.MISSING_DEPENDENCY,
            message: `Node '${node.id}' depends on '${depId}' which does not exist`,
            nodeId: node.id,
          });
        }
      }
    }
  }

  // 5. 变量引用合法性：所有 nodes.<id> 引用必须在 depends_on 中
  for (const node of def.nodes) {
    const referenced = scanTemplateDeps(node);
    const deps = new Set(node.depends_on ?? []);
    for (const depId of referenced) {
      if (!deps.has(depId)) {
        // 此时不应该发生（已自动补充），但做防御性检查
        issues.push({
          type: "error",
          code: WorkflowErrorCode.UNDEFINED_VARIABLE,
          message: `Node '${node.id}' references 'nodes.${depId}' without declaring it in depends_on`,
          nodeId: node.id,
        });
      }
    }
  }

  // 2. 环检测（Kahn 算法）
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of def.nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const node of def.nodes) {
    for (const depId of node.depends_on ?? []) {
      if (adjacency.has(depId)) {
        adjacency.get(depId)!.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (processed < def.nodes.length) {
    const cycleNodes = def.nodes.filter((n) => (inDegree.get(n.id) ?? 0) > 0).map((n) => n.id);
    throw new WorkflowError(
      `Cycle detected in DAG involving nodes: ${cycleNodes.join(", ")}`,
      WorkflowErrorCode.CYCLE_DETECTED,
      { nodeIds: cycleNodes },
    );
  }

  return {
    valid: issues.filter((i) => i.type === "error").length === 0,
    issues,
    def,
  };
}

/**
 * 扫描节点所有字符串字段中的 ${{ }} 模板，提取 nodes.<id> 引用
 */
function scanTemplateDeps(node: NodeDef): Set<string> {
  const refs = new Set<string>();
  scanNodeStrings(node, refs);
  return refs;
}

/**
 * 递归扫描节点定义的所有字符串值，查找 nodes.<id> 引用
 */
function scanNodeStrings(obj: unknown, refs: Set<string>): void {
  if (typeof obj === "string") {
    // 匹配 ${{ ... }} 中的 nodes.<id> 引用
    const templatePattern = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
    for (const match of obj.matchAll(templatePattern)) {
      const expr = match[1];
      extractNodeIdFromExpr(expr, refs);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      scanNodeStrings(item, refs);
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const val of Object.values(obj)) {
      scanNodeStrings(val, refs);
    }
  }
}

/**
 * 从表达式中提取 nodes.<id> 的 id
 * 简单扫描：找 `nodes.` 后面紧跟的标识符
 */
function extractNodeIdFromExpr(expr: string, refs: Set<string>): void {
  // 找 nodes.<id> 模式
  let idx = 0;
  while (idx < expr.length) {
    const nodesIdx = expr.indexOf("nodes.", idx);
    if (nodesIdx === -1) break;
    const start = nodesIdx + 6; // 'nodes.'.length
    if (start < expr.length && /[a-zA-Z_$]/.test(expr[start])) {
      let end = start;
      while (end < expr.length && /[a-zA-Z0-9_$]/.test(expr[end])) end++;
      refs.add(expr.slice(start, end));
      idx = end;
    } else {
      idx = nodesIdx + 6;
    }
  }
}
