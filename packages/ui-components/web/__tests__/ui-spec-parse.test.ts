import { describe, expect, test } from "bun:test";
import { parseUISpec } from "../chat/ui-spec/parse";
import { UI_SPEC_LIMITS as L, UI_SPEC_VERSION } from "../chat/ui-spec/spec";

/** 整块降级断言常量：shape 固定，避免用例里重复写对象字面量。 */
const STRUCTURE = { status: "degraded", reason: "structure" } as const;
const LIMITS = { status: "degraded", reason: "limits" } as const;
const JSON_ERROR = { status: "degraded", reason: "json" } as const;

/** 组装完整 Spec 正文；默认 version=1、root="root"，显式传 null 等假值时也能原样写入。 */
function spec(elements: unknown, options: { root?: unknown; version?: unknown } = {}): string {
  return JSON.stringify({
    version: Object.hasOwn(options, "version") ? options.version : UI_SPEC_VERSION,
    root: Object.hasOwn(options, "root") ? options.root : "root",
    elements,
  });
}

/** Stack 容器节点（children 省略表示叶状空容器）。 */
function stack(children?: string[]): Record<string, unknown> {
  return children === undefined ? { type: "Stack" } : { type: "Stack", children };
}

/** Text 叶节点。 */
function text(value = "hi"): Record<string, unknown> {
  return { type: "Text", props: { text: value } };
}

/** 构造正文长度恰好为 totalChars 的合法 Spec；填充串都 ≤ maxString，只触发正文长度这一项。 */
function paddedCode(totalChars: number): string {
  const prefix = '{"version":1,"root":"root","elements":{"root":{"type":"Text","props":{"text":"hi","pad":[';
  const suffix = "]}}}}";
  const payload = totalChars - prefix.length - suffix.length;
  const chunkCount = Math.ceil((payload + 1) / (L.maxString + 3));
  const chars = payload - (3 * chunkCount - 1);
  const base = Math.floor(chars / chunkCount);
  const extra = chars - base * chunkCount;
  const chunks = Array.from({ length: chunkCount }, (_, index) => "a".repeat(base + (index < extra ? 1 : 0)));
  const code = `${prefix}${chunks.map((chunk) => JSON.stringify(chunk)).join(",")}${suffix}`;
  if (code.length !== totalChars) throw new Error(`构造正文长度失败：${code.length} !== ${totalChars}`);
  return code;
}

/** 构造恰好 count 个元素的合法树：root 与中间层是 Stack、其余是 Text，children 不超上限。 */
function filledElements(count: number): { elements: Record<string, unknown>; root: string } {
  const elements: Record<string, unknown> = {};
  const root = "e0";
  const rootChildren: string[] = [];
  elements[root] = { type: "Stack", children: rootChildren };
  let created = 1;
  let parent: string[] = rootChildren;
  while (created < count) {
    if (parent.length >= L.maxChildren - 1) {
      // 当前父节点已满：留一个槽位给新的 Stack 分支，继续承载后续元素
      const branch = `b${created}`;
      const branchChildren: string[] = [];
      elements[branch] = { type: "Stack", children: branchChildren };
      parent.push(branch);
      parent = branchChildren;
    } else {
      const id = `e${created}`;
      elements[id] = text("x");
      parent.push(id);
    }
    created += 1;
  }
  return { elements, root };
}

/** 构造深度为 depth 的 Stack 链（root 深度从 1 计，最深处是 Text）。 */
function chainElements(depth: number): { elements: Record<string, unknown>; root: string } {
  const elements: Record<string, unknown> = {};
  for (let level = 1; level < depth; level += 1) {
    elements[`n${level}`] = { type: "Stack", children: [`n${level + 1}`] };
  }
  elements[`n${depth}`] = text("x");
  return { elements, root: "n1" };
}

/** 构造 props 本体嵌套 depth 层的对象（最外层对象算第 1 层）。 */
function nestedProps(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { x: 1 };
  for (let level = 1; level < depth; level += 1) {
    node = { x: node };
  }
  return node;
}

describe("parseUISpec：L0 正文限额", () => {
  // 正文长度上限先于 JSON.parse：超长输入不解析，整块降级原文（含尚未闭合的流式内容）
  test("maxCodeChars 的 N-1 / N 通过，N+1 降级 limits", () => {
    expect(parseUISpec(paddedCode(L.maxCodeChars - 1)).status).toBe("ok");
    expect(parseUISpec(paddedCode(L.maxCodeChars)).status).toBe("ok");
    expect(parseUISpec(paddedCode(L.maxCodeChars + 1))).toEqual(LIMITS);
  });

  // 非字符串入参（调用方误用）不抛异常，按不可解析处理
  test("非字符串入参不抛异常", () => {
    expect(parseUISpec(undefined as unknown as string)).toEqual(JSON_ERROR);
    expect(parseUISpec(123 as unknown as string)).toEqual(JSON_ERROR);
  });
});

describe("parseUISpec：L1 JSON", () => {
  // 语法错误整块降级：不补括号、不猜半截内容（流式半截正文由渲染层走原文）
  test("非法 JSON 一律 reason=json", () => {
    const inputs = [
      "",
      "{",
      '{"version":1,',
      '{"version":1,}',
      "{'version':1}",
      '{"version":1 /*x*/}',
      '{"version":1}tail',
    ];
    for (const input of inputs) {
      expect(parseUISpec(input)).toEqual(JSON_ERROR);
    }
  });
});

describe("parseUISpec：L1 结构（包络）", () => {
  // 顶层必须是普通对象：数组与原始值即使语法合法也不是 Spec
  test("非普通对象顶层 → structure", () => {
    for (const input of ["null", "1", '"x"', "[]", "true"]) {
      expect(parseUISpec(input)).toEqual(STRUCTURE);
    }
  });

  // 顶层只允许 version / root / elements：额外字段（含 __proto__ 键）不剥离后放行
  test("顶层额外字段 → structure", () => {
    expect(parseUISpec('{"version":1,"root":"r","elements":{"r":{"type":"Stack"}},"extra":1}')).toEqual(STRUCTURE);
    expect(
      parseUISpec('{"version":1,"root":"r","elements":{"r":{"type":"Stack"}},"__proto__":{"type":"Stack"}}'),
    ).toEqual(STRUCTURE);
  });

  // version / root / elements 三者都是必填
  test("缺必填字段 → structure", () => {
    expect(parseUISpec('{"root":"r","elements":{"r":{"type":"Stack"}}}')).toEqual(STRUCTURE);
    expect(parseUISpec('{"version":1,"elements":{"r":{"type":"Stack"}}}')).toEqual(STRUCTURE);
    expect(parseUISpec('{"version":1,"root":"r"}')).toEqual(STRUCTURE);
  });

  // version 必须是正整数：0 / 负数 / 小数 / 字符串 / null 都是结构错误，而不是「版本不支持」
  test("version 非正整数 → structure（不是 version 降级）", () => {
    for (const version of [0, -1, 1.5, "1", null, true, {}]) {
      expect(parseUISpec(spec({ root: stack() }, { version }))).toEqual(STRUCTURE);
    }
  });

  // root 必须是非空字符串
  test("root 空串或非字符串 → structure", () => {
    for (const root of ["", 1, null, [], {}]) {
      expect(parseUISpec(spec({ root: stack() }, { root }))).toEqual(STRUCTURE);
    }
    expect(parseUISpec(spec({ "": stack() }, { root: "" }))).toEqual(STRUCTURE);
  });

  // 空 elements 整块降级：不渲染空成功 UI，也不假装是合法 Spec
  test("空 elements 与 elements 非对象 → structure", () => {
    expect(parseUISpec(spec({}))).toEqual(STRUCTURE);
    expect(parseUISpec('{"version":1,"root":"r","elements":[]}')).toEqual(STRUCTURE);
    expect(parseUISpec('{"version":1,"root":"r","elements":"r"}')).toEqual(STRUCTURE);
  });
});

describe("parseUISpec：L1 结构（元素）", () => {
  // 元素必须是对象，且只允许 type / props / children 三个键
  test("元素形状错误 → structure", () => {
    const badElements = [
      null,
      "Stack",
      42,
      [],
      { type: "Stack", extra: 1 },
      { type: "" },
      { type: 1 },
      {},
      { type: "Stack", props: [] },
      { type: "Stack", props: "x" },
      { type: "Stack", children: "t" },
      { type: "Stack", children: [1] },
      { type: "Stack", children: [""] },
    ];
    for (const element of badElements) {
      expect(parseUISpec(spec({ root: element }))).toEqual(STRUCTURE);
    }
  });

  // 已知叶节点带非空 children 属于结构错误；缺省或 [] 允许
  test("已知叶节点的 children 规则", () => {
    expect(
      parseUISpec(spec({ root: stack(["t"]), t: { type: "Text", props: { text: "x" }, children: [] } })).status,
    ).toBe("ok");
    expect(
      parseUISpec(
        spec({ root: stack(["t"]), t: { type: "Text", props: { text: "x" }, children: ["t2"] }, t2: text() }),
      ),
    ).toEqual(STRUCTURE);
    expect(parseUISpec(spec({ root: stack(["u"]), u: { type: "Widget", children: [] } })).status).toBe("ok");
  });
});

describe("parseUISpec：L1 引用图", () => {
  // root 必须存在于 elements；引用不存在的 id 与不可达节点都不允许（不局部剪裁成残缺成功 UI）
  test("root 不存在 / 引用不存在 / 不可达节点 → structure", () => {
    expect(parseUISpec(spec({ r: stack() }, { root: "nope" }))).toEqual(STRUCTURE);
    expect(parseUISpec(spec({ root: stack(["missing"]) }))).toEqual(STRUCTURE);
    expect(parseUISpec(spec({ root: stack(), orphan: text() }))).toEqual(STRUCTURE);
  });

  // 同一 children 数组内重复引用（重复边）与多父共享都是结构错误：Spec 是树不是 DAG
  test("重复边与多父共享 → structure", () => {
    expect(parseUISpec(spec({ root: stack(["t", "t"]), t: text() }))).toEqual(STRUCTURE);
    expect(parseUISpec(spec({ root: stack(["a", "b"]), a: stack(["c"]), b: stack(["c"]), c: text() }))).toEqual(
      STRUCTURE,
    );
  });

  // 自环与多节点环整块降级：active-path 检测，不能靠全局 visited 静默跳过
  test("自环与多节点环 → structure", () => {
    expect(parseUISpec(spec({ root: stack(["root"]) }))).toEqual(STRUCTURE);
    expect(parseUISpec(spec({ root: stack(["a"]), a: stack(["root"]) }))).toEqual(STRUCTURE);
    expect(parseUISpec(spec({ root: stack(["a"]), a: stack(["b"]), b: stack(["c"]), c: stack(["b"]) }))).toEqual(
      STRUCTURE,
    );
  });

  // 合法的多层树通过，证明上面的拒绝不是「一律拒绝」
  test("合法多层树通过", () => {
    const code = spec({ root: stack(["a"]), a: stack(["t1", "t2"]), t1: text("1"), t2: text("2") });
    expect(parseUISpec(code).status).toBe("ok");
  });
});

describe("parseUISpec：L1 重名与原型键", () => {
  // 重复 JSON 键按 JSON.parse 语义：最后一个同名键生效，校验归一后的结果（不声称能检测覆盖）
  test("重复 JSON 键：最后键生效", () => {
    expect(parseUISpec('{"version":1,"version":2,"root":"r","elements":{"r":{"type":"Stack"}}}')).toEqual({
      status: "degraded",
      reason: "version",
      version: 2,
    });
    expect(
      parseUISpec('{"version":1,"root":"r","elements":{"r":{"type":"Stack","bogus":1},"r":{"type":"Stack"}}}').status,
    ).toBe("ok");
    const duplicated = parseUISpec(
      '{"version":1,"root":"r","elements":{"r":{"type":"Text","props":{"text":"a","text":"bb"}}}}',
    );
    expect(duplicated.status === "ok" ? duplicated.spec.elements.r.props?.text : null).toBe("bb");
  });

  // 原型名可以当 id / type：own-property 查表，且不得把 __proto__ 写成结果对象的原型
  test("原型名 id 与 type 是合法数据", () => {
    const code =
      '{"version":1,"root":"__proto__","elements":{"__proto__":{"type":"Stack","children":["constructor"]},' +
      '"constructor":{"type":"toString","children":["valueOf"]},"valueOf":{"type":"Text","props":{"text":"x"}}}}';
    const result = parseUISpec(code);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(Object.hasOwn(result.spec.elements, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.spec.elements)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
    expect(result.spec.elements["__proto__"].type).toBe("Stack");
    expect(result.spec.elements["__proto__"].children).toEqual(["constructor"]);
  });
});

describe("parseUISpec：L2 版本", () => {
  // 版本不支持时整块降级（不是结构错误）；version 字段供渲染层区分「过新」与「旧版本」文案
  test("version 不等于 1 → reason=version", () => {
    expect(parseUISpec(spec({ root: stack() }, { version: UI_SPEC_VERSION })).status).toBe("ok");
    expect(parseUISpec(spec({ root: stack() }, { version: 2 }))).toEqual({
      status: "degraded",
      reason: "version",
      version: 2,
    });
    expect(parseUISpec(spec({ root: stack() }, { version: 99 }))).toEqual({
      status: "degraded",
      reason: "version",
      version: 99,
    });
  });
});

describe("parseUISpec：L2 限额", () => {
  // 元素数量上限（§1.4 maxElements）
  test("maxElements 的 N-1 / N / N+1", () => {
    const at = (count: number) => {
      const { elements, root } = filledElements(count);
      return parseUISpec(JSON.stringify({ version: UI_SPEC_VERSION, root, elements }));
    };
    expect(at(L.maxElements - 1).status).toBe("ok");
    expect(at(L.maxElements).status).toBe("ok");
    expect(at(L.maxElements + 1)).toEqual(LIMITS);
  });

  // 树深度上限（root 从 1 计）
  test("maxDepth 的 N-1 / N / N+1", () => {
    const at = (depth: number) => {
      const { elements, root } = chainElements(depth);
      return parseUISpec(JSON.stringify({ version: UI_SPEC_VERSION, root, elements }));
    };
    expect(at(L.maxDepth - 1).status).toBe("ok");
    expect(at(L.maxDepth).status).toBe("ok");
    expect(at(L.maxDepth + 1)).toEqual(LIMITS);
  });

  // 单元素 children 数量上限
  test("maxChildren 的 N-1 / N / N+1", () => {
    const at = (count: number) => {
      const elements: Record<string, unknown> = {};
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        ids.push(`t${index}`);
        elements[`t${index}`] = text();
      }
      return parseUISpec(spec({ root: stack(ids), ...elements }));
    };
    expect(at(L.maxChildren - 1).status).toBe("ok");
    expect(at(L.maxChildren).status).toBe("ok");
    expect(at(L.maxChildren + 1)).toEqual(LIMITS);
  });

  // 任意字符串长度上限（props 值）
  test("maxString 的 N-1 / N / N+1（props 值）", () => {
    const at = (chars: number) => parseUISpec(spec({ root: { type: "Text", props: { text: "a".repeat(chars) } } }));
    expect(at(L.maxString - 1).status).toBe("ok");
    expect(at(L.maxString).status).toBe("ok");
    expect(at(L.maxString + 1)).toEqual(LIMITS);
  });

  // props 的键名同样是数据：键超长也整块降级
  test("maxString 也约束 props 键名", () => {
    expect(parseUISpec(spec({ root: { type: "Stack", props: { ["k".repeat(L.maxString + 1)]: 1 } } }))).toEqual(LIMITS);
  });

  // id 与 type 长度上限（超限是整块限额，不是元素级占位）
  test("maxIdChars 与 maxTypeChars 的 N-1 / N / N+1", () => {
    const longId = (chars: number) => {
      const id = "r".repeat(chars);
      return parseUISpec(JSON.stringify({ version: UI_SPEC_VERSION, root: id, elements: { [id]: stack() } }));
    };
    expect(longId(L.maxIdChars - 1).status).toBe("ok");
    expect(longId(L.maxIdChars).status).toBe("ok");
    expect(longId(L.maxIdChars + 1)).toEqual(LIMITS);

    const longType = (chars: number) => parseUISpec(spec({ root: { type: "T".repeat(chars) } }));
    expect(longType(L.maxTypeChars - 1).status).toBe("ok");
    expect(longType(L.maxTypeChars).status).toBe("ok");
    expect(longType(L.maxTypeChars + 1)).toEqual(LIMITS);
  });

  // props 嵌套超深：迭代扫描后拒绝，不交给 zod（避免递归爆栈）；props 本体算第 1 层
  test("props 嵌套深度的 N-1 / N / N+1", () => {
    const at = (depth: number) => parseUISpec(spec({ root: { type: "Stack", props: { p: nestedProps(depth) } } }));
    expect(at(L.maxDepth - 2).status).toBe("ok");
    expect(at(L.maxDepth - 1).status).toBe("ok");
    expect(at(L.maxDepth)).toEqual(LIMITS);
  });
});

describe("parseUISpec：成功产物", () => {
  // 归一化输出：只保留白名单键，props / children 缺省按 {} / [] 补齐，供渲染层直接消费
  test("成功产物已归一化", () => {
    const result = parseUISpec(spec({ root: stack(["t"]), t: { type: "Text", props: { text: "hi" } } }));
    expect(result).toEqual({
      status: "ok",
      spec: {
        version: UI_SPEC_VERSION,
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["t"] },
          t: { type: "Text", props: { text: "hi" }, children: [] },
        },
      },
    });
  });

  // 未知 type 在 parse 阶段是合法数据（L3 目录才判 unsupported），不能整块降级
  test("未知 type 与任意 props 不导致整块降级", () => {
    expect(parseUISpec(spec({ root: { type: "Widget", props: { anything: [1, { a: "b" }] } } })).status).toBe("ok");
  });

  // 纯函数：同一输入重复调用判定一致，没有隐藏状态
  test("同一输入判定稳定", () => {
    const code = spec({ root: stack(["t"]), t: text() });
    expect(parseUISpec(code)).toEqual(parseUISpec(code));
  });

  // 解析层对任何字符串都不抛异常，渲染层可以无条件调用
  test("任意输入不抛异常", () => {
    const inputs = ["", "{", "[]", "null", "\u0000", '{"version":1,"root":"r","elements":{"r":{"type":"Stack"}}}'];
    for (const input of inputs) {
      expect(() => parseUISpec(input)).not.toThrow();
    }
    expect(() => parseUISpec("a".repeat(L.maxCodeChars + 10))).not.toThrow();
  });
});
