import type { SQL } from "drizzle-orm";

/**
 * 在 JS 中求值授权谓词，用于「谓词 ⟺ 动作推导」一致性合同测试。
 *
 * 为什么需要它：谓词的语义只有数据库能真正执行，而包级单测不允许依赖外部 Postgres。这里改为
 * 直接解释 Drizzle 的 SQL chunk 树——谓词只由 `eq` / `inArray` / `and` / `or` / `sql\`false\``
 * 组成，结构小且封闭，因此可以离线求值并逐条断言等价性。
 *
 * 求值器只接受它能识别的结构，遇到未知 chunk 或运算符立即抛错：Drizzle 升级或谓词编译器引入
 * 新算子时必须显式扩展本文件，而不是让合同测试静默通过。
 */

type Token =
  | { readonly kind: "or" }
  | { readonly kind: "and" }
  | { readonly kind: "(" }
  | { readonly kind: ")" }
  | { readonly kind: "literal"; readonly value: boolean }
  | { readonly kind: "compare"; readonly column: string; readonly values: readonly unknown[] };

type Node =
  | { readonly kind: "literal"; readonly value: boolean }
  | { readonly kind: "compare"; readonly column: string; readonly values: readonly unknown[] }
  | { readonly kind: "or" | "and"; readonly children: readonly Node[] };

function isSqlNode(chunk: unknown): chunk is SQL {
  return typeof chunk === "object" && chunk !== null && Array.isArray((chunk as SQL).queryChunks);
}

function isStringChunk(chunk: unknown): chunk is { value: string[] } {
  const value = (chunk as { value?: unknown }).value;
  return Array.isArray(value) && typeof value[0] === "string";
}

function isColumnNode(chunk: unknown): chunk is { name: string } {
  const candidate = chunk as { name?: unknown; dataType?: unknown; columnType?: unknown };
  return typeof candidate.name === "string" && candidate.dataType !== undefined && candidate.columnType !== undefined;
}

/** 把 chunk 树摊平成记号流；叶子条件在摊平期就完成识别。 */
function tokenize(chunks: readonly unknown[], tokens: Token[]): void {
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined || chunk === null) continue;
    if (isSqlNode(chunk)) {
      tokenize(chunk.queryChunks as readonly unknown[], tokens);
      continue;
    }
    if (isStringChunk(chunk)) {
      pushTextToken(chunk.value.join(""), tokens);
      continue;
    }
    if (isColumnNode(chunk)) {
      const operator = textOf(chunks[index + 1]);
      const values = paramValues(chunks[index + 2]);
      if (operator === "=") tokens.push({ kind: "compare", column: chunk.name, values });
      else if (operator === "in") tokens.push({ kind: "compare", column: chunk.name, values });
      else throw new Error(`授权谓词求值器不支持运算符：${operator}`);
      index += 2;
      continue;
    }
    throw new Error(`授权谓词求值器不支持的 chunk：${String((chunk as object).constructor?.name)}`);
  }
}

function textOf(chunk: unknown): string {
  if (!isStringChunk(chunk)) throw new Error("授权谓词结构异常：列之后缺少运算符");
  return chunk.value.join("").trim();
}

function paramValues(chunk: unknown): readonly unknown[] {
  if (Array.isArray(chunk)) {
    return chunk.map((item) => (item as { value?: unknown }).value);
  }
  return [(chunk as { value?: unknown }).value];
}

function pushTextToken(text: string, tokens: Token[]): void {
  const trimmed = text.trim();
  if (trimmed === "") return;
  if (trimmed === "(") tokens.push({ kind: "(" });
  else if (trimmed === ")") tokens.push({ kind: ")" });
  else if (trimmed === "or") tokens.push({ kind: "or" });
  else if (trimmed === "and") tokens.push({ kind: "and" });
  else if (trimmed === "false") tokens.push({ kind: "literal", value: false });
  else if (trimmed === "true") tokens.push({ kind: "literal", value: true });
  else throw new Error(`授权谓词求值器不支持的记号：${trimmed}`);
}

/** 递归下降解析：`or` 优先级最低，括号与叶子条件为基本单元。 */
function parse(tokens: readonly Token[]): Node {
  let cursor = 0;
  const parsePrimary = (): Node => {
    const token = tokens[cursor];
    if (token === undefined) throw new Error("授权谓词结构异常：表达式提前结束");
    if (token.kind === "(") {
      cursor += 1;
      const node = parseOr();
      if (tokens[cursor]?.kind !== ")") throw new Error("授权谓词结构异常：括号未闭合");
      cursor += 1;
      return node;
    }
    cursor += 1;
    if (token.kind === "literal") return { kind: "literal", value: token.value };
    if (token.kind === "compare") return { kind: "compare", column: token.column, values: token.values };
    throw new Error(`授权谓词结构异常：意外的记号 ${token.kind}`);
  };
  const parseAnd = (): Node => {
    const first = parsePrimary();
    const children = [first];
    while (tokens[cursor]?.kind === "and") {
      cursor += 1;
      children.push(parsePrimary());
    }
    return children.length === 1 ? first : { kind: "and", children };
  };
  const parseOr = (): Node => {
    const first = parseAnd();
    const children = [first];
    while (tokens[cursor]?.kind === "or") {
      cursor += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? first : { kind: "or", children };
  };

  const node = parseOr();
  if (cursor !== tokens.length) throw new Error("授权谓词结构异常：存在未消费的记号");
  return node;
}

function evaluate(node: Node, row: Readonly<Record<string, unknown>>): boolean {
  if (node.kind === "literal") return node.value;
  if (node.kind === "or") return node.children.some((child) => evaluate(child, row));
  if (node.kind === "and") return node.children.every((child) => evaluate(child, row));
  return node.values.includes(row[node.column]);
}

/**
 * 判断一行主表数据是否满足授权谓词。
 *
 * `undefined` 谓词代表"整段省略"（super-admin 的 `bypass`），因此对任何行都成立；行以**SQL 列名**
 * 为键，`null` 表示该列无值。
 */
export function rowSatisfiesPredicate(predicate: SQL | undefined, row: Readonly<Record<string, unknown>>): boolean {
  if (predicate === undefined) return true;
  const tokens: Token[] = [];
  tokenize(predicate.queryChunks as readonly unknown[], tokens);
  return evaluate(parse(tokens), row);
}
