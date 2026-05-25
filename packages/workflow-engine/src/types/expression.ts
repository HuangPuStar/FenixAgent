/** 表达式 AST 节点类型 */
export type ASTNode =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "identifier"; name: string }
  | { kind: "member_access"; object: ASTNode; property: string }
  | { kind: "index_access"; object: ASTNode; index: ASTNode }
  | { kind: "binary"; op: string; left: ASTNode; right: ASTNode }
  | { kind: "unary"; op: string; operand: ASTNode }
  | { kind: "ternary"; condition: ASTNode; consequent: ASTNode; alternate: ASTNode };

/** 表达式求值上下文 */
export interface EvalContext {
  nodes?: Record<string, { output: Record<string, unknown>; status: string }>;
  params?: Record<string, unknown>;
  secrets?: Record<string, string>;
}
