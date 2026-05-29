/**
 * 表达式解析与求值模块
 *
 * 支持 `${{ expr }}` 模板中的表达式解析、求值和模板解析。
 * 命名空间：`nodes.<id>.output.xxx`、`nodes.<id>.status`、`params.xxx`、`secrets.KEY`
 */

import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { ASTNode, EvalContext } from "../types/expression";

// ---------- 常量 ----------

const MAX_EXPR_LENGTH = 1024;
const MAX_ACCESS_DEPTH = 10;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_ROOTS = new Set(["nodes", "params", "secrets"]);

// ---------- 类型守卫 ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------- 词法分析器（手写字符扫描器） ----------

enum TokenType {
  Ident,
  Number,
  String,
  Dot,
  LBracket,
  RBracket,
  LParen,
  RParen,
  Question,
  Colon,
  Bang,
  Op, // ==, !=, >, <, >=, <=, &&, ||, +
  EOF,
}

interface Token {
  type: TokenType;
  value: string;
}

class Lexer {
  private pos = 0;

  constructor(private readonly source: string) {}

  peek(): string {
    return this.pos < this.source.length ? this.source[this.pos] : "\0";
  }

  advance(): string {
    return this.source[this.pos++];
  }

  at(offset: number): string {
    const i = this.pos + offset;
    return i < this.source.length ? this.source[i] : "\0";
  }

  skipWhitespace(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) {
      this.pos++;
    }
  }

  next(): Token {
    this.skipWhitespace();
    const ch = this.peek();

    if (ch === "\0") return { type: TokenType.EOF, value: "" };

    // 数字
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(this.at(1)))) {
      const start = this.pos;
      if (ch === "-") this.advance();
      while (/[0-9]/.test(this.peek())) this.advance();
      if (this.peek() === ".") {
        this.advance();
        while (/[0-9]/.test(this.peek())) this.advance();
      }
      return { type: TokenType.Number, value: this.source.slice(start, this.pos) };
    }

    // 字符串字面量（单引号或双引号）
    if (ch === '"' || ch === "'") {
      return this.readString();
    }

    // 标识符
    if (/[a-zA-Z_$]/.test(ch)) {
      const start = this.pos;
      while (/[a-zA-Z0-9_$]/.test(this.peek())) this.advance();
      return { type: TokenType.Ident, value: this.source.slice(start, this.pos) };
    }

    this.advance();

    switch (ch) {
      case ".":
        return { type: TokenType.Dot, value: "." };
      case "[":
        return { type: TokenType.LBracket, value: "[" };
      case "]":
        return { type: TokenType.RBracket, value: "]" };
      case "(":
        return { type: TokenType.LParen, value: "(" };
      case ")":
        return { type: TokenType.RParen, value: ")" };
      case "?":
        return { type: TokenType.Question, value: "?" };
      case ":":
        return { type: TokenType.Colon, value: ":" };
      case "!":
        if (this.peek() === "=") {
          this.advance();
          return { type: TokenType.Op, value: "!=" };
        }
        return { type: TokenType.Bang, value: "!" };
      case "=":
        if (this.peek() === "=") {
          this.advance();
          return { type: TokenType.Op, value: "==" };
        }
        throw new WorkflowError(`Unexpected character: '${ch}'`, WorkflowErrorCode.INVALID_EXPRESSION);
      case ">":
        if (this.peek() === "=") {
          this.advance();
          return { type: TokenType.Op, value: ">=" };
        }
        return { type: TokenType.Op, value: ">" };
      case "<":
        if (this.peek() === "=") {
          this.advance();
          return { type: TokenType.Op, value: "<=" };
        }
        return { type: TokenType.Op, value: "<" };
      case "&":
        if (this.peek() === "&") {
          this.advance();
          return { type: TokenType.Op, value: "&&" };
        }
        throw new WorkflowError(`Unexpected character: '${ch}'`, WorkflowErrorCode.INVALID_EXPRESSION);
      case "|":
        if (this.peek() === "|") {
          this.advance();
          return { type: TokenType.Op, value: "||" };
        }
        throw new WorkflowError(`Unexpected character: '${ch}'`, WorkflowErrorCode.INVALID_EXPRESSION);
      case "+":
        return { type: TokenType.Op, value: "+" };
      default:
        throw new WorkflowError(`Unexpected character: '${ch}'`, WorkflowErrorCode.INVALID_EXPRESSION);
    }
  }

  private readString(): Token {
    const quote = this.advance();
    const start = this.pos;
    while (this.peek() !== quote && this.peek() !== "\0") {
      if (this.peek() === "\\") this.advance();
      this.advance();
    }
    if (this.peek() === "\0") {
      throw new WorkflowError("Unterminated string literal", WorkflowErrorCode.INVALID_EXPRESSION);
    }
    this.advance(); // closing quote
    return { type: TokenType.String, value: this.source.slice(start, this.pos - 1) };
  }
}

// ---------- 递归下降解析器 ----------

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: "" };
  }

  advance(): Token {
    const tok = this.tokens[this.pos];
    this.pos++;
    return tok ?? { type: TokenType.EOF, value: "" };
  }

  expect(type: TokenType, value?: string): Token {
    const tok = this.peek();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new WorkflowError(
        `Expected ${value ?? TokenType[type]} but got '${tok.value}'`,
        WorkflowErrorCode.INVALID_EXPRESSION,
      );
    }
    return this.advance();
  }

  /** 入口：ternary → or → and → comparison → concat → unary → postfix → primary */
  parse(): ASTNode {
    const node = this.parseTernary();
    if (this.peek().type !== TokenType.EOF) {
      throw new WorkflowError(
        `Unexpected token after expression: '${this.peek().value}'`,
        WorkflowErrorCode.INVALID_EXPRESSION,
      );
    }
    return node;
  }

  private parseTernary(): ASTNode {
    const cond = this.parseOr();
    if (this.peek().type === TokenType.Question) {
      this.advance();
      const consequent = this.parseTernary();
      this.expect(TokenType.Colon);
      const alternate = this.parseTernary();
      return { kind: "ternary", condition: cond, consequent, alternate };
    }
    return cond;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.peek().type === TokenType.Op && this.peek().value === "||") {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseComparison();
    while (this.peek().type === TokenType.Op && this.peek().value === "&&") {
      this.advance();
      const right = this.parseComparison();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }

  private parseComparison(): ASTNode {
    let left = this.parseConcat();
    const tok = this.peek();
    if (tok.type === TokenType.Op && ["==", "!=", ">", "<", ">=", "<="].includes(tok.value)) {
      this.advance();
      const right = this.parseConcat();
      left = { kind: "binary", op: tok.value, left, right };
    }
    return left;
  }

  private parseConcat(): ASTNode {
    let left = this.parseUnary();
    while (this.peek().type === TokenType.Op && this.peek().value === "+") {
      this.advance();
      const right = this.parseUnary();
      left = { kind: "binary", op: "+", left, right };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    const tok = this.peek();
    if (tok.type === TokenType.Bang) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: "unary", op: "!", operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ASTNode {
    let node = this.parsePrimary();

    for (;;) {
      const tok = this.peek();
      if (tok.type === TokenType.Dot) {
        this.advance();
        const prop = this.expect(TokenType.Ident);
        node = { kind: "member_access", object: node, property: prop.value };
      } else if (tok.type === TokenType.LBracket) {
        this.advance();
        const index = this.parseTernary();
        this.expect(TokenType.RBracket);
        node = { kind: "index_access", object: node, index };
      } else {
        break;
      }
    }

    return node;
  }

  private parsePrimary(): ASTNode {
    const tok = this.peek();

    if (tok.type === TokenType.Number) {
      this.advance();
      const v = Number(tok.value);
      return { kind: "literal", value: v };
    }

    if (tok.type === TokenType.String) {
      this.advance();
      return { kind: "literal", value: tok.value };
    }

    if (tok.type === TokenType.Ident) {
      // null / true / false 关键字
      if (tok.value === "null") {
        this.advance();
        return { kind: "literal", value: null };
      }
      if (tok.value === "true") {
        this.advance();
        return { kind: "literal", value: true };
      }
      if (tok.value === "false") {
        this.advance();
        return { kind: "literal", value: false };
      }
      this.advance();
      return { kind: "identifier", name: tok.value };
    }

    if (tok.type === TokenType.LParen) {
      this.advance();
      const inner = this.parseTernary();
      this.expect(TokenType.RParen);
      return inner;
    }

    throw new WorkflowError(
      `Unexpected token: '${tok.value}' (${TokenType[tok.type]})`,
      WorkflowErrorCode.INVALID_EXPRESSION,
    );
  }
}

// ---------- 求值器 ----------

/**
 * 解析表达式字符串为 AST
 * @throws WorkflowError(INVALID_EXPRESSION) 语法错误
 * @throws WorkflowError(EXPRESSION_TOO_LONG) 超过长度限制
 */
export function parseExpression(expr: string): ASTNode {
  if (expr.length > MAX_EXPR_LENGTH) {
    throw new WorkflowError(`Expression exceeds max length ${MAX_EXPR_LENGTH}`, WorkflowErrorCode.EXPRESSION_TOO_LONG);
  }
  const lexer = new Lexer(expr);
  const tokens: Token[] = [];
  for (;;) {
    const tok = lexer.next();
    tokens.push(tok);
    if (tok.type === TokenType.EOF) break;
  }
  const parser = new Parser(tokens);
  return parser.parse();
}

/**
 * 递归求值 AST 节点
 * @throws WorkflowError(UNDEFINED_VARIABLE) 访问了不允许的命名空间
 * @throws WorkflowError(EXPRESSION_TOO_DEEP) 超过最大访问深度
 */
export function evaluateExpression(ast: ASTNode, context: EvalContext, depth = 0): unknown {
  if (depth > MAX_ACCESS_DEPTH) {
    throw new WorkflowError(
      `Expression access depth exceeds ${MAX_ACCESS_DEPTH}`,
      WorkflowErrorCode.EXPRESSION_TOO_DEEP,
    );
  }

  switch (ast.kind) {
    case "literal":
      return ast.value;

    case "identifier": {
      const name = ast.name;
      if (!ALLOWED_ROOTS.has(name)) {
        throw new WorkflowError(`Undefined variable: '${name}'`, WorkflowErrorCode.UNDEFINED_VARIABLE);
      }
      if (name === "nodes") return context.nodes ?? null;
      if (name === "params") return context.params ?? null;
      if (name === "secrets") return context.secrets ?? null;
      return null;
    }

    case "member_access": {
      const obj = evaluateExpression(ast.object, context, depth + 1);
      if (BLOCKED_KEYS.has(ast.property)) {
        throw new WorkflowError(`Blocked property access: '${ast.property}'`, WorkflowErrorCode.UNDEFINED_VARIABLE);
      }
      if (obj === null || obj === undefined) return null;
      if (isObject(obj)) return obj[ast.property] ?? null;
      return null;
    }

    case "index_access": {
      const obj = evaluateExpression(ast.object, context, depth + 1);
      const idx = evaluateExpression(ast.index, context, depth + 1);
      if (obj === null || obj === undefined) return null;
      if (Array.isArray(obj)) {
        if (typeof idx === "number") return (idx >= 0 && idx < obj.length ? obj[idx] : null) ?? null;
        return null;
      }
      if (isObject(obj) && typeof idx === "string") return obj[idx] ?? null;
      return null;
    }

    case "unary": {
      if (ast.op === "!") {
        const val = evaluateExpression(ast.operand, context, depth + 1);
        return !val;
      }
      throw new WorkflowError(`Unknown unary operator: '${ast.op}'`, WorkflowErrorCode.INVALID_EXPRESSION);
    }

    // biome-ignore lint/suspicious/noFallthroughSwitchClause: binary case block ends with return/throw
    case "binary": {
      // 短路求值
      if (ast.op === "&&") {
        const left = evaluateExpression(ast.left, context, depth + 1);
        return left ? evaluateExpression(ast.right, context, depth + 1) : left;
      }
      if (ast.op === "||") {
        const left = evaluateExpression(ast.left, context, depth + 1);
        return left ? left : evaluateExpression(ast.right, context, depth + 1);
      }

      const left = evaluateExpression(ast.left, context, depth + 1);
      const right = evaluateExpression(ast.right, context, depth + 1);

      switch (ast.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
        case "<":
        case ">=":
        case "<=":
          // null 参与排序比较时一律返回 false（仅 null == null 为 true）
          if (left === null || right === null) return false;
          switch (ast.op) {
            case ">":
              return (left as number) > (right as number);
            case "<":
              return (left as number) < (right as number);
            case ">=":
              return (left as number) >= (right as number);
            case "<=":
              return (left as number) <= (right as number);
          }
          break;
        case "+":
          if (typeof left === "string" || typeof right === "string") {
            return String(left ?? "") + String(right ?? "");
          }
          return (left as number) + (right as number);
        default:
          throw new WorkflowError(`Unknown binary operator: '${ast.op}'`, WorkflowErrorCode.INVALID_EXPRESSION);
      }
    }

    case "ternary": {
      const cond = evaluateExpression(ast.condition, context, depth + 1);
      return cond
        ? evaluateExpression(ast.consequent, context, depth + 1)
        : evaluateExpression(ast.alternate, context, depth + 1);
    }

    default: {
      const _exhaustive: never = ast;
      throw new WorkflowError(`Unknown AST node kind`, WorkflowErrorCode.INVALID_EXPRESSION);
    }
  }
}

/**
 * 解析模板字符串，将 `${{ expr }}` 替换为求值结果
 * 非表达式文本原样保留，null 值替换为空字符串
 */
export function resolveTemplate(template: string, context: EvalContext): string {
  const result: string[] = [];
  let lastEnd = 0;

  for (let i = 0; i < template.length; i++) {
    // 检查 `${{`
    if (template[i] === "$" && template[i + 1] === "{" && template[i + 2] === "{") {
      result.push(template.slice(lastEnd, i));
      // 找到匹配的 `}}`
      let depth = 1;
      let j = i + 3;
      for (; j < template.length; j++) {
        if (template[j] === "}" && template[j + 1] === "}") {
          depth--;
          if (depth === 0) break;
          j++; // skip second }
        }
        if (template[j] === "{" && template[j + 1] === "{") {
          depth++;
          j++; // skip second {
        }
      }
      if (depth !== 0) {
        throw new WorkflowError("Unterminated ${{ expression", WorkflowErrorCode.INVALID_EXPRESSION);
      }
      const expr = template.slice(i + 3, j).trim();
      const ast = parseExpression(expr);
      const val = evaluateExpression(ast, context);
      result.push(val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : String(val));
      lastEnd = j + 2;
      i = j + 1; // for loop 会 +1
    }
  }

  result.push(template.slice(lastEnd));
  return result.join("");
}
