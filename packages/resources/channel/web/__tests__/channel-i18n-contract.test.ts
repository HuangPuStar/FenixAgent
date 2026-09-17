import { describe, expect, test } from "bun:test";
import ts from "typescript";
import channelsEN from "../i18n/en/channels.json";
import channelsZH from "../i18n/zh/channels.json";

/** 组件内可静态校验与动态翻译调用的 AST 扫描结果。 */
interface TranslationCalls {
  keys: string[];
  dynamicCalls: string[];
}

/** 未通过翻译函数提供的用户可见 JSX 静态属性。 */
interface BareJsxAttribute {
  attribute: string;
  value: string;
}

/** 递归收集语言资源的字符串叶子键，用于校验双语资源结构完全一致。 */
function flattenTranslationKeys(resource: unknown, prefix = ""): string[] {
  if (typeof resource === "string") return prefix ? [prefix] : [];
  if (typeof resource !== "object" || resource === null) return [];
  return Object.entries(resource).flatMap(([key, value]) =>
    flattenTranslationKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

/** 通过 TypeScript AST 收集 t() 的静态键，并单独报告无法静态验证的动态调用。 */
function collectTranslationCalls(sourceFile: ts.SourceFile): TranslationCalls {
  const keys: string[] = [];
  const dynamicCalls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const [argument] = node.arguments;
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        keys.push(argument.text);
      } else {
        dynamicCalls.push(node.getText(sourceFile));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { keys, dynamicCalls };
}

/** 查找 JSX 用户可见属性中的裸静态字符串，同时覆盖文本和表达式两种写法。 */
function collectBareJsxAttributes(sourceFile: ts.SourceFile, attributeNames: ReadonlySet<string>): BareJsxAttribute[] {
  const attributes: BareJsxAttribute[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && attributeNames.has(node.name.text)) {
      const initializer = node.initializer;
      if (initializer && ts.isStringLiteral(initializer)) {
        attributes.push({ attribute: node.name.text, value: initializer.text });
      } else if (
        initializer &&
        ts.isJsxExpression(initializer) &&
        initializer.expression &&
        (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression))
      ) {
        attributes.push({ attribute: node.name.text, value: initializer.expression.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return attributes;
}

/** 以 TSX 模式解析测试源码，保留父节点以支持准确诊断。 */
function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile("AgentChannelsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const source = await Bun.file(new URL("../pages/agent-panel/pages/AgentChannelsPage.tsx", import.meta.url)).text();
const sourceFile = parseTsx(source);
const USER_VISIBLE_JSX_ATTRIBUTES = new Set([
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "searchPlaceholder",
  "emptyMessage",
  "description",
]);

describe("AgentChannelsPage i18n contract", () => {
  // 中英文资源必须拥有完全相同的字符串叶子键，避免单语言新增或遗漏。
  test("中英文资源键集合完全一致", () => {
    expect(flattenTranslationKeys(channelsZH).sort()).toEqual(flattenTranslationKeys(channelsEN).sort());
  });

  // 组件内所有 t() 都必须是可静态验证的键，且同时存在于两份语言资源。
  test("组件所有静态翻译调用均能解析", () => {
    const calls = collectTranslationCalls(sourceFile);
    const zhKeys = new Set(flattenTranslationKeys(channelsZH));
    const enKeys = new Set(flattenTranslationKeys(channelsEN));

    expect(calls.dynamicCalls).toEqual([]);
    expect(calls.keys.length).toBeGreaterThan(0);
    expect(calls.keys.filter((key) => !zhKeys.has(key) || !enKeys.has(key))).toEqual([]);
  });

  // placeholder 等用户可见 JSX 属性不能绕过 i18n 使用裸字符串。
  test("用户可见 JSX 属性不包含裸字符串", () => {
    expect(collectBareJsxAttributes(sourceFile, USER_VISIBLE_JSX_ATTRIBUTES)).toEqual([]);
  });

  // AST 规则必须对所有可见 props 同时识别直接字符串、表达式字符串和无插值模板。
  test("裸字符串检查覆盖全部可见 props 与静态语法", () => {
    const fixture = parseTsx(`
      const Direct = () => <Widget
        placeholder="direct-placeholder"
        title="direct-title"
        aria-label="direct-aria"
        alt="direct-alt"
        searchPlaceholder="direct-search"
        emptyMessage="direct-empty"
        description="direct-description"
      />;
      const Expression = () => <Widget
        placeholder={"expression-placeholder"}
        title={"expression-title"}
        aria-label={"expression-aria"}
        alt={"expression-alt"}
        searchPlaceholder={"expression-search"}
        emptyMessage={"expression-empty"}
        description={"expression-description"}
      />;
      const Template = () => <Widget
        placeholder={\`template-placeholder\`}
        title={\`template-title\`}
        aria-label={\`template-aria\`}
        alt={\`template-alt\`}
        searchPlaceholder={\`template-search\`}
        emptyMessage={\`template-empty\`}
        description={\`template-description\`}
      />;
    `);

    expect(collectBareJsxAttributes(fixture, USER_VISIBLE_JSX_ATTRIBUTES)).toEqual([
      { attribute: "placeholder", value: "direct-placeholder" },
      { attribute: "title", value: "direct-title" },
      { attribute: "aria-label", value: "direct-aria" },
      { attribute: "alt", value: "direct-alt" },
      { attribute: "searchPlaceholder", value: "direct-search" },
      { attribute: "emptyMessage", value: "direct-empty" },
      { attribute: "description", value: "direct-description" },
      { attribute: "placeholder", value: "expression-placeholder" },
      { attribute: "title", value: "expression-title" },
      { attribute: "aria-label", value: "expression-aria" },
      { attribute: "alt", value: "expression-alt" },
      { attribute: "searchPlaceholder", value: "expression-search" },
      { attribute: "emptyMessage", value: "expression-empty" },
      { attribute: "description", value: "expression-description" },
      { attribute: "placeholder", value: "template-placeholder" },
      { attribute: "title", value: "template-title" },
      { attribute: "aria-label", value: "template-aria" },
      { attribute: "alt", value: "template-alt" },
      { attribute: "searchPlaceholder", value: "template-search" },
      { attribute: "emptyMessage", value: "template-empty" },
      { attribute: "description", value: "template-description" },
    ]);
  });

  // t() 调用是已国际化的动态表达式，不能被静态字符串规则误报。
  test("合法翻译表达式不报裸字符串", () => {
    const fixture = parseTsx(`
      const Demo = () => <Widget
        placeholder={t("dialog.platformPlaceholder")}
        title={t("dialog.title")}
        aria-label={t("dialog.agent")}
        alt={t("dialog.platform")}
        searchPlaceholder={t("table.searchPlaceholder")}
        emptyMessage={t("table.emptyMessage")}
        description={t("confirm.deleteDescription")}
      />;
    `);

    expect(collectBareJsxAttributes(fixture, USER_VISIBLE_JSX_ATTRIBUTES)).toEqual([]);
  });
});
