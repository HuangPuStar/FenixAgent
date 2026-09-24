import { describe, expect, test } from "bun:test";
import { fromPackageSlug, toPackageSlug } from "../server/domain/slug";

/**
 * 包名 ↔ URL 段（slug）的编解码契约。
 *
 * 这里锁定的是**路由形状**的稳定性：一个 slug 必须是一个不会被打散、不会被代理改写的路径段，且同一个包名
 * 永远得到同一个 slug。它**不是**安全边界——slug 解码出的字符串只作为 SQL 绑定参数使用，包名本身的合法性由
 * `npm-registry/normalize.ts` 的 `assertPackageName` 判定（见下面「穿越形状」那条用例）。
 *
 * 用例不读写任何全局状态、不连接数据库。
 */

describe("slug", () => {
  // 普通包名必须可逆：slug 是路由与缓存键，编不出、解不回会让详情页 404。
  test("round-trips a plain package name", () => {
    // 字面量而非「再算一遍」：把编码方案写死在契约里，换方案（如改十六进制）必须是一次显式决定。
    const slug = toPackageSlug("acme-investment-team");
    expect(slug).toBe("p-YWNtZS1pbnZlc3RtZW50LXRlYW0");
    expect(fromPackageSlug(slug)).toBe("acme-investment-team");
  });

  // scoped 包名含 `/`：编码后必须仍是**一个**路径段，否则详情页会被路由拆成两段而 404。
  test("encodes a scoped package name as a single path segment", () => {
    const slug = toPackageSlug("@acme/investment-team");
    expect(slug).not.toContain("/");
    expect(slug).not.toContain("%");
    expect(fromPackageSlug(slug)).toBe("@acme/investment-team");
  });

  // 不同包名不得塌缩成同一个 slug：折叠大小写或改写 scope 分隔符会让两个包共享一个详情页。
  test("keeps distinct names distinct", () => {
    const names = ["acme-team", "Acme-Team", "@acme/team", "@acme-team", "acme/team"];
    const slugs = names.map(toPackageSlug);
    expect(new Set(slugs).size).toBe(names.length);
    expect(slugs.map((slug) => fromPackageSlug(slug))).toEqual(names);
  });

  // 形状不对的输入必须在查询发生之前就被否掉：前缀缺失、空体、填充符、标准 base64 字符、百分号与路径分隔。
  test("rejects anything that is not a canonical slug shape", () => {
    const rejected = [
      "acme-investment-team", // 缺前缀
      "p-", // 空体
      "p-YQ==", // 填充符
      "p-YQ+", // 标准 base64 的 `+`
      "p-YQ/", // 标准 base64 的 `/`（也正是要被规避的路径分隔符）
      "p-..%2F..%2Fetc%2Fpasswd", // 百分号编码的穿越形状
      "p-../../etc/passwd",
      "p-YQ ", // 空白
      "p-Y Q",
    ];
    expect(rejected.map((slug) => fromPackageSlug(slug))).toEqual(rejected.map(() => null));
  });

  // 非规范编码必须被否掉：`YWJ` 与 `YWI` 解出同一串字节，只有规范的那个才代表一个包。
  test("rejects non-canonical base64url that decodes to a valid name", () => {
    // `toPackageSlug("ab")` 的规范形式是 `p-YWI`；`p-YWJ` 少了尾字节的有效位，却能被宽松解码成 "ab"。
    expect(fromPackageSlug("p-YWI")).toBe("ab");
    expect(fromPackageSlug("p-YWJ")).toBeNull();
  });

  // 解出非法 UTF-8 的字节序列同样不是规范编码：往 (U+FFFD) 的重编码结果与原串不同，因此被否掉。
  test("rejects a body that decodes to invalid UTF-8", () => {
    expect(fromPackageSlug("p-_w")).toBeNull();
  });

  // slug 不是安全边界：规范编码的穿越形状会原样解出，它的安全前提是「解码结果只作为绑定参数交给包名校验」。
  // 这里把结论写死在测试里，避免日后有人误以为 slug 在替包名校验兜底。
  test("does not act as a package name validator", () => {
    expect(fromPackageSlug("p-Li4vLi4vZXRjL3Bhc3N3b3Jk")).toBe("../../etc/password");
  });

  // 非字符串输入（路由参数之外的 JS 调用）必须返回 null 而不是抛错：解不出来是常态，不是异常。
  test("returns null for non-string input", () => {
    expect(fromPackageSlug(undefined as unknown as string)).toBeNull();
  });
});
