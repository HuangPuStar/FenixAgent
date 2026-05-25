/**
 * i18n 覆盖率扫描脚本
 *
 * 检测前端 TSX 文件中未国际化的硬编码文本，并生成结构化报告。
 *
 * 用法：
 *   bun run scripts/check-i18n.ts          # 默认报告
 *   bun run scripts/check-i18n.ts --json   # JSON 输出
 *   bun run scripts/check-i18n.ts --fix-hint  # 附带修复建议
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ─── 配置 ────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");
const WEB_SRC = join(ROOT, "web/src");
const WEB_COMPONENTS = join(ROOT, "web/components");
const I18N_DIR = join(WEB_SRC, "i18n/locales");

// 不需要扫描的目录/文件
const EXCLUDE_PATTERNS = [
  "/ui/",           // shadcn 基础组件
  "/__tests__/",    // 测试文件
  ".test.",         // 测试文件
  "/i18n/",         // i18n 框架本身
  "routeTree.gen.", // 自动生成路由
];

// JSX 属性中需要检查的属性名（这些是用户可见文本）
const CHECKED_ATTRS = ["placeholder", "title", "aria-label", "alt", "label", "description"];

// 纯英文单词的正则（至少 2 个字母，排除技术标识符）
const ENGLISH_WORD_RE = /^[A-Za-z][a-z]+(?: [A-Za-z]?[a-z]+)*$/;

// 中文字符正则
const CHINESE_RE = /[\u4e00-\u9fff]/;

// ─── 工具函数 ──────────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  col: number;
  text: string;
  type: "chinese" | "english" | "attr-string";
  context: string;
  attrName?: string;
}

interface FileReport {
  file: string;
  usesI18n: boolean;
  violations: Violation[];
}

function walkDir(dir: string, ext: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, ext));
      } else if (entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  } catch {
    // 目录不存在则跳过
  }
  return results;
}

function shouldExclude(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return EXCLUDE_PATTERNS.some((p) => normalized.includes(p));
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

// 提取行内字符串字面量（单引号、双引号）
function extractStringLiterals(line: string): { text: string; col: number }[] {
  const results: { text: string; col: number }[] = [];
  // 匹配 "..." 和 '...'
  const re = /(["'])(.*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const text = match[2];
    if (text.length >= 2) {
      results.push({ text, col: match.index + 1 });
    }
  }
  return results;
}

// 检查字符串是否为技术性标识符（不需要国际化）
function isTechnicalString(text: string): boolean {
  // CSS 类名、HTML 属性值、技术标识符
  if (/^[a-z-]+(?:-[a-z-]+)*$/.test(text)) return true; // kebab-case
  if (/^[a-z]+\.[a-z]+/i.test(text)) return true; // 带点的标识符
  if (/^https?:\/\//.test(text)) return true; // URL
  if (/^[./{}[\]()]+$/.test(text)) return true; // 纯符号
  if (/^\d+$/.test(text)) return true; // 纯数字
  if (text.length < 2) return true; // 太短
  // 纯标点/符号
  if (/^[\s\-_=+*/\\|<>!@#$%^&*()[\]{};:'",.?`~]+$/.test(text)) return true;
  // CSS property / HTML attribute patterns
  if (/^(flex|grid|block|inline|none|auto|hidden|visible|scroll|fixed|absolute|relative|sticky)$/.test(text)) return true;
  // 常见技术词汇
  const TECH_WORDS = [
    "Shift", "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Control", "Meta", "Backspace", "Delete", "Space",
    "FileReader error", "Clipboard API not available",
    "true", "false", "null", "undefined",
    "Promise", "void", "string", "number", "boolean", "Record", "Array", "Map", "Set",
  ];
  if (TECH_WORDS.includes(text)) return true;
  // TypeScript 类型位置：行内含 "=> type" 或 ": type" 模式
  if (/=>\s*(Promise|void|string|number|boolean)\b/.test(text)) return true;
  return false;
}

// ─── 核心扫描逻辑 ──────────────────────────────────────────────────────

function scanFile(filePath: string): FileReport {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relativePath = relative(ROOT, filePath);
  const usesI18n = content.includes("useTranslation");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // 跳过注释行
    if (isCommentLine(line)) continue;
    // 跳过 import 行
    if (line.trimStart().startsWith("import ")) continue;
    // 跳过 console 调试信息（根据 CLAUDE.md 规则）
    if (/console\.(log|error|warn|debug|info)/.test(line)) continue;
    // 跳过已经使用 t() 的行
    if (/\bt\(/.test(line) && !/\/\/.*\bt\(/.test(line.split("//")[0] ?? "")) continue;
    // 跳过 type/interface 行
    if (/^\s*(export\s+)?(type|interface)\s/.test(line)) continue;

    // ── 检测 1: JSX 属性中的硬编码字符串 ──
    for (const attr of CHECKED_ATTRS) {
      // 匹配 attr="..." 或 attr='...'
      const attrRe = new RegExp(`${attr.replace("-", "\\s*-\\s*")}\\s*=\\s*(["'])(.*?)\\1`, "g");
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRe.exec(line)) !== null) {
        const text = attrMatch[2];
        if (!text || isTechnicalString(text)) continue;
        if (CHINESE_RE.test(text) || (ENGLISH_WORD_RE.test(text) && text.length >= 3)) {
          violations.push({
            file: relativePath,
            line: lineNum,
            col: attrMatch.index + 1,
            text,
            type: "attr-string",
            context: line.trim(),
            attrName: attr,
          });
        }
      }
      // 匹配 JSX attr={...} 中包含字符串字面量的情况
      const jsxAttrExprRe = new RegExp(`${attr.replace("-", "\\s*-\\s*")}\\s*=\\s*\\{\\s*(["'\`])(.*?)\\1\\s*\\}`, "g");
      while ((attrMatch = jsxAttrExprRe.exec(line)) !== null) {
        const text = attrMatch[2];
        if (!text || isTechnicalString(text)) continue;
        if (CHINESE_RE.test(text) || (ENGLISH_WORD_RE.test(text) && text.length >= 3)) {
          violations.push({
            file: relativePath,
            line: lineNum,
            col: attrMatch.index + 1,
            text,
            type: "attr-string",
            context: line.trim(),
            attrName: attr,
          });
        }
      }
    }

    // ── 检测 2: JSX 文本节点中的硬编码中文 ──
    // 匹配 >中文文本< 或 > English text <
    const jsxTextRe = />([^<{]{2,})</g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = jsxTextRe.exec(line)) !== null) {
      const text = textMatch[1].trim();
      if (!text || isTechnicalString(text)) continue;
      if (CHINESE_RE.test(text)) {
        violations.push({
          file: relativePath,
          line: lineNum,
          col: textMatch.index + 1,
          text,
          type: "chinese",
          context: line.trim(),
        });
      } else if (ENGLISH_WORD_RE.test(text) && text.length >= 4) {
        violations.push({
          file: relativePath,
          line: lineNum,
          col: textMatch.index + 1,
          text,
          type: "english",
          context: line.trim(),
        });
      }
    }

    // ── 检测 3: 对象字面量中的字符串映射（如 statusMap）──
    // 匹配 "key": "Value" 模式，且 Value 包含中文或英文单词
    if (/{\s*$/.test(lines[i - 1]?.trimEnd() ?? "") || /^\s*{/.test(line)) {
      // 检查是否在 status/map 对象内
      const mapEntryRe = /^\s*["'][\w-]+["']\s*:\s*["']([^"']+)["']/;
      const mapMatch = mapEntryRe.exec(line);
      if (mapMatch) {
        const text = mapMatch[1];
        if (CHINESE_RE.test(text) || (ENGLISH_WORD_RE.test(text) && text.length >= 4)) {
          // 检查上方是否有 t( 调用或 i18n 相关
          const prev5Lines = lines.slice(Math.max(0, i - 5), i).join("\n");
          if (!prev5Lines.includes("useTranslation") && !prev5Lines.includes("t(")) {
            violations.push({
              file: relativePath,
              line: lineNum,
              col: mapMatch.index + 1,
              text,
              type: CHINESE_RE.test(text) ? "chinese" : "english",
              context: line.trim(),
            });
          }
        }
      }
    }

    // ── 检测 4: 条件表达式中的硬编码字符串 ──
    // 如: isX ? "Yes" : "No"  或  foo ? "中文字符" : "Other"
    const condRe = /\?\s*["']([^"']{2,})["']\s*:\s*["']([^"']{2,})["']/g;
    let condMatch: RegExpExecArray | null;
    while ((condMatch = condRe.exec(line)) !== null) {
      for (const text of [condMatch[1], condMatch[2]]) {
        if (isTechnicalString(text)) continue;
        if (CHINESE_RE.test(text) || (ENGLISH_WORD_RE.test(text) && text.length >= 3)) {
          violations.push({
            file: relativePath,
            line: lineNum,
            col: condMatch.index + 1,
            text,
            type: CHINESE_RE.test(text) ? "chinese" : "english",
            context: line.trim(),
          });
        }
      }
    }

    // ── 检测 5: 字符串赋值中的硬编码（变量 = "文本"）──
    const assignRe = /(?:const|let|var)\s+\w+\s*=\s*["']([^"']{2,})["']/;
    const assignMatch = assignRe.exec(line);
    if (assignMatch) {
      const text = assignMatch[1];
      if (!isTechnicalString(text) && (CHINESE_RE.test(text) || (ENGLISH_WORD_RE.test(text) && text.length >= 4))) {
        violations.push({
          file: relativePath,
          line: lineNum,
          col: assignMatch.index + 1,
          text,
          type: CHINESE_RE.test(text) ? "chinese" : "english",
          context: line.trim(),
        });
      }
    }
  }

  // 去重（同一行同一文本可能被多个规则匹配）
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.file}:${v.line}:${v.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { file: relativePath, usesI18n, violations: unique };
}

// ─── 翻译文件检查 ──────────────────────────────────────────────────────

interface NamespaceReport {
  namespace: string;
  enKeys: string[];
  zhKeys: string[];
  missingInZh: string[];
  missingInEn: string[];
  totalKeys: number;
}

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function checkTranslationFiles(): NamespaceReport[] {
  const reports: NamespaceReport[] = [];
  const enDir = join(I18N_DIR, "en");
  const zhDir = join(I18N_DIR, "zh");

  try {
    const enFiles = readdirSync(enDir).filter((f) => f.endsWith(".json"));
    for (const file of enFiles) {
      const ns = file.replace(".json", "");
      const enData = JSON.parse(readFileSync(join(enDir, file), "utf-8"));
      const zhPath = join(zhDir, file);

      let zhData: Record<string, unknown> = {};
      try {
        zhData = JSON.parse(readFileSync(zhPath, "utf-8"));
      } catch {
        // zh 文件不存在
      }

      const enKeys = flattenKeys(enData);
      const zhKeys = flattenKeys(zhData);
      const enSet = new Set(enKeys);
      const zhSet = new Set(zhKeys);

      reports.push({
        namespace: ns,
        enKeys,
        zhKeys,
        missingInZh: enKeys.filter((k) => !zhSet.has(k)),
        missingInEn: zhKeys.filter((k) => !enSet.has(k)),
        totalKeys: enKeys.length,
      });
    }
  } catch {
    // i18n 目录不存在
  }

  return reports;
}

// ─── 未使用翻译 key 检查 ──────────────────────────────────────────────

function findUnusedKeys(reports: NamespaceReport[], allFiles: string[]): Map<string, string[]> {
  const unused = new Map<string, Set<string>>();
  for (const r of reports) {
    unused.set(r.namespace, new Set(r.enKeys));
  }

  const tCallRe = /\bt\(\s*["']([^"']+)["']/g;

  for (const filePath of allFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      // 从 useTranslation 的参数推断 namespace
      const nsMatch = content.match(/useTranslation\s*\(\s*NS\.(\w+)/g);
      const namespaces = nsMatch?.map((m) => {
        const name = m.replace(/useTranslation\s*\(\s*NS\./, "");
        // NS 常量名到实际 namespace 的映射
        const nsMap: Record<string, string> = {
          COMMON: "common", LOGIN: "login", SIDEBAR: "sidebar", DASHBOARD: "dashboard",
          AGENTS: "agents", MODELS: "models", SKILLS: "skills", MCP: "mcp",
          TASKS: "tasks", WORKFLOWS: "workflows", SESSIONS: "sessions",
          ENVIRONMENTS: "environments", ORGS: "orgs", APIKEY: "apikey",
          CHANNELS: "channels", KNOWLEDGE: "knowledge", AGENT_PANEL: "agentPanel",
          COMPONENTS: "components",
        };
        return nsMap[name] ?? name.toLowerCase();
      }) ?? [];

      // 也检查直接用字符串的 useTranslation("namespace")
      const nsStrMatch = content.match(/useTranslation\s*\(\s*["']([^"']+)["']/g);
      if (nsStrMatch) {
        for (const m of nsStrMatch) {
          const ns = m.replace(/useTranslation\s*\(\s*["']/, "").replace(/["']\)$/, "");
          if (!namespaces.includes(ns)) namespaces.push(ns);
        }
      }

      // 默认 namespace 是 common
      if (namespaces.length === 0) namespaces.push("common");

      // 扫描 t() 调用
      let match: RegExpExecArray | null;
      const contentForSearch = content;
      tCallRe.lastIndex = 0;
      while ((match = tCallRe.exec(contentForSearch)) !== null) {
        const key = match[1];
        for (const ns of namespaces) {
          unused.get(ns)?.delete(key);
          // 也尝试删除带前缀的 key（t("a.b") 可能对应 { a: { b: "..." } }）
          const parts = key.split(".");
          for (let i = 1; i < parts.length; i++) {
            unused.get(ns)?.delete(parts.slice(0, i).join(".") + ".");
          }
        }
      }
    } catch {
      // 跳过读取失败的文件
    }
  }

  const result = new Map<string, string[]>();
  for (const [ns, keys] of unused) {
    if (keys.size > 0) {
      result.set(ns, [...keys].sort());
    }
  }
  return result;
}

// ─── 报告生成 ──────────────────────────────────────────────────────────

function formatReport(
  fileReports: FileReport[],
  nsReports: NamespaceReport[],
  unusedKeys: Map<string, string[]>,
  options: { json: boolean; fixHint: boolean },
): string {
  if (options.json) {
    return JSON.stringify({
      files: fileReports,
      namespaces: nsReports,
      unusedKeys: Object.fromEntries(unusedKeys),
      summary: buildSummary(fileReports, nsReports, unusedKeys),
    }, null, 2);
  }

  const output: string[] = [];
  const W = (s: string) => output.push(s);

  const summary = buildSummary(fileReports, nsReports, unusedKeys);

  // ── 标题 ──
  W("\n\x1b[1m\x1b[36m══════════════════════════════════════════════════\x1b[0m");
  W("\x1b[1m\x1b[36m  i18n 覆盖率扫描报告\x1b[0m");
  W("\x1b[1m\x1b[36m══════════════════════════════════════════════════\x1b[0m\n");

  // ── 总览 ──
  W("\x1b[1m📊 总览\x1b[0m");
  W(`   TSX 文件总数（排除 ui/测试）:  ${summary.totalFiles}`);
  W(`   使用 useTranslation:           \x1b[32m${summary.filesWithI18n}\x1b[0m`);
  W(`   未使用 useTranslation:         \x1b[33m${summary.filesWithoutI18n}\x1b[0m`);
  W(`   含硬编码违规的文件:            \x1b[31m${summary.filesWithViolations}\x1b[0m`);
  W(`   i18n 采用率:                   \x1b[${summary.adoptionRate >= 80 ? 32 : summary.adoptionRate >= 50 ? 33 : 31}m${summary.adoptionRate}%\x1b[0m`);
  W("");

  // ── 硬编码违规详情 ──
  const violationFiles = fileReports.filter((r) => r.violations.length > 0);
  if (violationFiles.length > 0) {
    W("\x1b[1m🔍 硬编码文本违规\x1b[0m");
    W("");

    let totalChinese = 0;
    let totalEnglish = 0;
    let totalAttr = 0;

    for (const report of violationFiles) {
      const i18nTag = report.usesI18n ? "\x1b[32m[已引入i18n]\x1b[0m" : "\x1b[31m[未引入i18n]\x1b[0m";
      W(`  \x1b[1m${report.file}\x1b[0m ${i18nTag}`);

      for (const v of report.violations) {
        const typeIcon = v.type === "chinese" ? "🇨🇳" : v.type === "english" ? "🔤" : "🏷️";
        const typeLabel = v.type === "chinese" ? "中文" : v.type === "english" ? "英文" : `属性(${v.attrName})`;
        const color = v.type === "chinese" ? "\x1b[31m" : "\x1b[33m";

        W(`    ${typeIcon} L${v.line}: ${color}"${v.text}"\x1b[0m  (${typeLabel})`);

        if (options.fixHint) {
          W(`       💡 → t("${toKeyHint(v.text)}")`);
        }

        if (v.type === "chinese") totalChinese++;
        else if (v.type === "english") totalEnglish++;
        else totalAttr++;
      }
      W("");
    }

    W(`  小计: \x1b[31m${totalChinese} 处中文\x1b[0m · \x1b[33m${totalEnglish} 处英文\x1b[0m · \x1b[35m${totalAttr} 处属性\x1b[0m = \x1b[1m${totalChinese + totalEnglish + totalAttr} 处违规\x1b[0m`);
    W("");
  }

  // ── 未使用 i18n 的文件列表 ──
  const noI18nFiles = fileReports.filter((r) => !r.usesI18n);
  if (noI18nFiles.length > 0) {
    W("\x1b[1m📄 未使用 useTranslation 的文件\x1b[0m");
    W("");

    // 分类
    const routeFiles = noI18nFiles.filter((r) => r.file.includes("/routes/"));
    const componentFiles = noI18nFiles.filter((r) => !r.file.includes("/routes/"));

    if (routeFiles.length > 0) {
      W("  路由壳文件（通常不需要 i18n）:");
      for (const r of routeFiles) {
        W(`    \x1b[90m${r.file}\x1b[0m`);
      }
      W("");
    }

    if (componentFiles.length > 0) {
      W("  组件/页面文件:");
      for (const r of componentFiles) {
        const violationCount = r.violations.length;
        const tag = violationCount > 0 ? `\x1b[31m(${violationCount} 处违规)\x1b[0m` : "\x1b[90m(无可见文本)\x1b[0m";
        W(`    ${r.file} ${tag}`);
      }
      W("");
    }
  }

  // ── 翻译文件完整性 ──
  W("\x1b[1m🌐 翻译文件完整性\x1b[0m");
  W("");
  W("  命名空间          en keys    zh keys    状态");
  W("  ──────────────── ────────── ────────── ──────");

  let totalKeys = 0;
  let allGood = true;
  for (const r of nsReports.sort((a, b) => a.namespace.localeCompare(b.namespace))) {
    totalKeys += r.totalKeys;
    const status = r.missingInZh.length === 0 && r.missingInEn.length === 0
      ? "\x1b[32m✓ 完整\x1b[0m"
      : `\x1b[31m✗ 缺 ${r.missingInZh.length + r.missingInEn.length} key\x1b[0m`;
    if (r.missingInZh.length > 0 || r.missingInEn.length > 0) allGood = false;
    W(`  ${r.namespace.padEnd(17)} ${(String(r.enKeys.length)).padEnd(10)} ${(String(r.zhKeys.length)).padEnd(10)} ${status}`);
  }
  W("");
  W(`  总计: ${totalKeys} keys, ${allGood ? "\x1b[32men/zh 完全一致 ✓\x1b[0m" : "\x1b[31men/zh 存在差异 ✗\x1b[0m"}`);
  W("");

  // ── 未使用的翻译 key ──
  if (unusedKeys.size > 0) {
    W("\x1b[1m🗑️ 可能未使用的翻译 key\x1b[0m");
    W("");
    for (const [ns, keys] of unusedKeys) {
      W(`  \x1b[33m${ns}\x1b[0m (${keys.length} 个):`);
      for (const k of keys.slice(0, 10)) {
        W(`    - ${k}`);
      }
      if (keys.length > 10) {
        W(`    ... 还有 ${keys.length - 10} 个`);
      }
    }
    W("");
  }

  // ── 修复优先级建议 ──
  if (violationFiles.length > 0) {
    W("\x1b[1m📋 修复优先级建议\x1b[0m");
    W("");

    // 按违规数量排序
    const sorted = [...violationFiles].sort((a, b) => b.violations.length - a.violations.length);

    W("  P0 — 高频组件（Chat/工具调用/状态显示）:");
    const p0 = sorted.filter((r) =>
      /chat\/|ai-elements\/|ChatView|ChatInput|tool\.tsx|reasoning/.test(r.file)
    );
    for (const r of p0) {
      W(`    \x1b[31m${r.file}\x1b[0m (${r.violations.length} 处)`);
    }

    W("");
    W("  P1 — 配置/连接组件:");
    const p1 = sorted.filter((r) =>
      /config\/|ACPConnect|ContextPanel/.test(r.file) && !/chat\/|ai-elements\//.test(r.file)
    );
    for (const r of p1) {
      W(`    \x1b[33m${r.file}\x1b[0m (${r.violations.length} 处)`);
    }

    W("");
    W("  P2 — 其他:");
    const p2 = sorted.filter((r) => !p0.includes(r) && !p1.includes(r));
    for (const r of p2) {
      W(`    \x1b[90m${r.file}\x1b[0m (${r.violations.length} 处)`);
    }
    W("");
  }

  return output.join("\n");
}

function buildSummary(
  fileReports: FileReport[],
  nsReports: NamespaceReport[],
  unusedKeys: Map<string, string[]>,
) {
  const totalFiles = fileReports.length;
  const filesWithI18n = fileReports.filter((r) => r.usesI18n).length;
  const filesWithoutI18n = totalFiles - filesWithI18n;
  const filesWithViolations = fileReports.filter((r) => r.violations.length > 0).length;
  const totalViolations = fileReports.reduce((sum, r) => sum + r.violations.length, 0);
  const adoptionRate = totalFiles > 0 ? Math.round((filesWithI18n / totalFiles) * 100) : 0;

  return {
    totalFiles,
    filesWithI18n,
    filesWithoutI18n,
    filesWithViolations,
    totalViolations,
    adoptionRate,
    namespaces: nsReports.length,
    totalKeys: nsReports.reduce((s, r) => s + r.totalKeys, 0),
    namespacesWithMissingKeys: nsReports.filter((r) => r.missingInZh.length > 0 || r.missingInEn.length > 0).length,
    unusedKeyCount: [...unusedKeys.values()].reduce((s, v) => s + v.length, 0),
  };
}

function toKeyHint(text: string): string {
  // 简单的文本到 key 的提示
  return text
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(".")
    .toLowerCase() || "key";
}

// ─── 主入口 ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const fixHint = args.includes("--fix-hint");

// 收集所有 TSX 文件
const allFiles = [
  ...walkDir(WEB_SRC, ".tsx"),
  ...walkDir(WEB_COMPONENTS, ".tsx"),
]
  .filter((f) => !shouldExclude(f))
  .sort();

// 扫描文件
const fileReports: FileReport[] = [];
for (const filePath of allFiles) {
  fileReports.push(scanFile(filePath));
}

// 检查翻译文件
const nsReports = checkTranslationFiles();

// 查找未使用的 key
const unusedKeys = findUnusedKeys(nsReports, allFiles);

// 生成报告
const report = formatReport(fileReports, nsReports, unusedKeys, { json: jsonMode, fixHint });
console.log(report);
