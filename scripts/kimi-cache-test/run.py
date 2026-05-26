#!/usr/bin/env python3
"""
Kimi API 缓存命中率测试工具

验证 api.kimi.com/coding (Anthropic 协议) 的多轮对话缓存行为。
system prompt 内嵌运行时间戳，确保每次测试都是全新请求，排除旧缓存干扰。

用法:
    export KIMI_API_KEY="sk-kimi-xxx"
    python3 scripts/kimi-cache-test/run.py                      # 运行全部测试
    python3 scripts/kimi-cache-test/run.py anthropic-prefix     # 只运行指定测试
    python3 scripts/kimi-cache-test/run.py --interval 3         # 自定义请求间隔
    python3 scripts/kimi-cache-test/run.py --key sk-kimi-xxx    # 或直接传 key

测试项:
    anthropic-prefix         无缓存参数，多轮 prefix 缓存 + 完全重复测试
    anthropic-cache-control  cache_control breakpoint 机制
    anthropic-cache-key      prompt_cache_key 参数有无对比

输出:
    logs/<timestamp>/
    ├── <test>/
    │   ├── test.log             纯文本日志 (无特殊符号)
    │   ├── round_01.json        每轮请求/响应完整数据
    │   └── ...
    ├── requests.jsonl           全部请求/响应原始数据 (每行一个 JSON)
    └── report.md                汇总报告
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import urllib.request
import urllib.error

# ─── 常量 ──────────────────────────────────────────────

ANTHROPIC_URL = "https://api.kimi.com/coding/v1/messages"

ALL_TESTS = [
    "anthropic-prefix",
    "anthropic-cache-control",
    "anthropic-cache-key",
]

# ─── 颜色 (仅终端) ────────────────────────────────────

RED = "\033[0;31m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
CYAN = "\033[0;36m"
BOLD = "\033[1m"
RESET = "\033[0m"

TAG_OK = "[OK]"
TAG_FAIL = "[FAIL]"


def strip_ansi(s: str) -> str:
    return re.sub(r"\033\[[0-9;]*m", "", s)


def build_system_prompt() -> str:
    """生成带时间戳的 system prompt，确保每次运行是全新请求"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
    return (
        f"当前时间: {ts}。"
        "你是 Kimi，由 Moonshot AI 开发。你是专业编程助手，用中文回答。"
        "规则：1.结构清晰 2.代码注释 3.优化建议 4.底层原理 "
        "5.最佳实践 6.安全性 7.可维护性 8.测试 9.错误处理 10.边界情况。"
    )


# ─── HTTP 请求 ─────────────────────────────────────────

def http_post(url: str, headers: dict, body: dict) -> tuple[dict, int, int]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)

    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            http_code = resp.status
            resp_body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        http_code = e.code
        resp_body = json.loads(e.read().decode("utf-8"))
    latency_ms = int((time.time() - start) * 1000)

    return resp_body, http_code, latency_ms


def anthropic_request(system: str, messages: list, extra: dict | None = None) -> tuple[dict, int, int]:
    headers = {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": "kimi-for-coding",
        "max_tokens": 128,
        "system": system,
        "messages": messages,
    }
    if extra:
        body.update(extra)
    return http_post(ANTHROPIC_URL, headers, body)


def anthropic_request_array_system(
    system: str, messages: list, cache_in_messages: bool = False, extra: dict | None = None
) -> tuple[dict, int, int]:
    headers = {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    system_block = {
        "type": "text",
        "text": system,
        "cache_control": {"type": "ephemeral"},
    }

    msg_list = []
    for m in messages:
        entry = {"role": m["role"], "content": m["content"]}
        if cache_in_messages and m["role"] == "assistant":
            entry["cache_control"] = {"type": "ephemeral"}
        msg_list.append(entry)

    body = {
        "model": "kimi-for-coding",
        "max_tokens": 128,
        "system": [system_block],
        "messages": msg_list,
    }
    if extra:
        body.update(extra)
    return http_post(ANTHROPIC_URL, headers, body)


# ─── 日志记录器 ────────────────────────────────────────

class Logger:
    def __init__(self, log_dir: Path):
        self.log_dir = log_dir
        self.jsonl_path = log_dir / "requests.jsonl"
        self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        self.jsonl_file = open(self.jsonl_path, "a", encoding="utf-8")
        self.current_log = None
        self.current_test_dir = None
        self.all_entries: list[dict] = []
        self._round_counter = 0

    def open_test_log(self, test_name: str):
        self.current_test_dir = self.log_dir / test_name
        self.current_test_dir.mkdir(parents=True, exist_ok=True)
        path = self.current_test_dir / "test.log"
        self.current_log = open(path, "w", encoding="utf-8")
        self._round_counter = 0

    def close_test_log(self):
        if self.current_log:
            self.current_log.close()
            self.current_log = None
            self.current_test_dir = None

    def log(self, msg: str):
        print(msg)
        if self.current_log:
            self.current_log.write(strip_ansi(msg) + "\n")
            self.current_log.flush()

    def record(
        self, test: str, round_num: int, protocol: str, endpoint: str,
        http_code: int, latency_ms: int, request_body: dict, response: dict
    ):
        self._round_counter += 1
        entry = {
            "timestamp": datetime.now().isoformat(),
            "test": test,
            "round": round_num,
            "protocol": protocol,
            "endpoint": endpoint,
            "http_code": http_code,
            "latency_ms": latency_ms,
            "request": request_body,
            "response": response,
        }
        self.all_entries.append(entry)

        self.jsonl_file.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self.jsonl_file.flush()

        if self.current_test_dir:
            round_path = self.current_test_dir / f"round_{self._round_counter:02d}.json"
            with open(round_path, "w", encoding="utf-8") as f:
                json.dump(entry, f, ensure_ascii=False, indent=2)

    def print_usage(self, resp: dict):
        if "error" in resp:
            err_msg = json.dumps(resp["error"], ensure_ascii=False)[:300]
            self.log(f"  {RED}{TAG_FAIL} Error: {err_msg}{RESET}")
            return

        usage = resp.get("usage", {})
        if not usage:
            self.log(f"  {RED}{TAG_FAIL} Error: 无 usage 字段{RESET}")
            return

        pt = usage.get("prompt_tokens", 0)
        ct = usage.get("completion_tokens", 0)
        cc = usage.get("cache_creation_input_tokens", 0)
        cr = usage.get("cache_read_input_tokens", 0)

        self.log(f"  prompt_tokens={pt}, cache_creation={cc}, cache_read={cr}, completion_tokens={ct}")
        if cr > 0 and pt > 0:
            rate = cr / pt * 100
            self.log(f"  {GREEN}{TAG_OK} 缓存命中率: {rate:.1f}%{RESET}")
        else:
            self.log(f"  {RED}{TAG_FAIL} 缓存命中率: 0% (无 prefix cache){RESET}")

    def generate_report(self):
        report_path = self.log_dir / "report.md"
        tests: dict[str, list[dict]] = {}
        for e in self.all_entries:
            tests.setdefault(e["test"], []).append(e)

        with open(report_path, "w", encoding="utf-8") as f:
            f.write("# Kimi API 缓存测试报告\n\n")
            f.write(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"总请求数: {len(self.all_entries)}\n\n---\n\n")

            for test_name, rounds in tests.items():
                f.write(f"## {test_name}\n\n")
                f.write("| 轮次 | 消息数 | prompt_tokens | cache_creation | cache_read | 命中率 | HTTP | 延迟ms |\n")
                f.write("|------|--------|---------------|----------------|------------|--------|------|--------|\n")
                for e in rounds:
                    r = e["round"]
                    resp = e.get("response", {})
                    usage = resp.get("usage", {})
                    err = resp.get("error")

                    if usage:
                        msgs = len(e["request"].get("messages", []))
                        pt = usage.get("prompt_tokens", 0)
                        cc = usage.get("cache_creation_input_tokens", 0)
                        cr = usage.get("cache_read_input_tokens", 0)
                        rate = f"{cr / pt * 100:.1f}%" if pt > 0 and cr > 0 else "0%"
                        f.write(f"| {r} | {msgs} | {pt} | {cc} | {cr} | {rate} | {e['http_code']} | {e['latency_ms']} |\n")
                    elif err:
                        f.write(f"| {r} | - | - | - | - | - | {e['http_code']} | {e['latency_ms']} | Error: {str(err)[:60]} |\n")
                f.write("\n")

            f.write("## 结论\n\n")
            f.write("- 若 **cache_creation 始终为 0**: 未实现 Anthropic cache_control breakpoint\n")
            f.write("- 若 **多轮递增对话 cache_read 始终为 0**: 未实现 prefix caching\n")
            f.write("- 若 **仅完全重复请求有 cache_read**: 底层为全量 hash 缓存，非 prefix 匹配\n")
            f.write("- 若 **prompt_cache_key 有效果**: Kimi 自定义缓存机制，但非 Anthropic 标准\n")

        return report_path

    def close(self):
        self.jsonl_file.close()
        if self.current_log:
            self.current_log.close()


# ─── 测试用例消息 ──────────────────────────────────────

BUS_ROUNDS = [
    [{"role": "user", "content": "用 TypeScript 实现 EventBus 模式"}],
    [
        {"role": "user", "content": "用 TypeScript 实现 EventBus 模式"},
        {"role": "assistant", "content": "EventBus 使用泛型和 Map 管理事件监听器，支持 on/off/emit 核心方法。"},
        {"role": "user", "content": "加上 once 和 removeAllListeners 方法"},
    ],
    [
        {"role": "user", "content": "用 TypeScript 实现 EventBus 模式"},
        {"role": "assistant", "content": "EventBus 使用泛型和 Map 管理事件监听器，支持 on/off/emit 核心方法。"},
        {"role": "user", "content": "加上 once 和 removeAllListeners 方法"},
        {"role": "assistant", "content": "once 用包装回调实现一次性监听，removeAllListeners 清空指定或全部监听器。"},
        {"role": "user", "content": "加上 TypeScript 类型安全的事件名约束"},
    ],
]

CONDITION_ROUNDS = [
    [{"role": "user", "content": "解释 TypeScript 条件类型"}],
    [
        {"role": "user", "content": "解释 TypeScript 条件类型"},
        {"role": "assistant", "content": "条件类型形如 T extends U ? X : Y，根据类型关系选择分支。"},
        {"role": "user", "content": "给一个分布式条件类型例子"},
    ],
    [
        {"role": "user", "content": "解释 TypeScript 条件类型"},
        {"role": "assistant", "content": "条件类型形如 T extends U ? X : Y，根据类型关系选择分支。"},
        {"role": "user", "content": "给一个分布式条件类型例子"},
        {"role": "assistant", "content": "裸类型参数作用于联合类型时自动分发，如 ToArray<string|number> = string[]|number[]。"},
        {"role": "user", "content": "infer 关键字怎么用？"},
    ],
    [
        {"role": "user", "content": "解释 TypeScript 条件类型"},
        {"role": "assistant", "content": "条件类型形如 T extends U ? X : Y，根据类型关系选择分支。"},
        {"role": "user", "content": "给一个分布式条件类型例子"},
        {"role": "assistant", "content": "裸类型参数作用于联合类型时自动分发，如 ToArray<string|number> = string[]|number[]。"},
        {"role": "user", "content": "infer 关键字怎么用？"},
        {"role": "assistant", "content": "infer 在条件类型中推断类型变量，如 ReturnType<T> = T extends (...args:any[]) => infer R ? R : never。"},
        {"role": "user", "content": "模板字面量类型结合条件类型？"},
    ],
]

MAPPED_ROUNDS = [
    [{"role": "user", "content": "解释 TypeScript 映射类型"}],
    [
        {"role": "user", "content": "解释 TypeScript 映射类型"},
        {"role": "assistant", "content": "映射类型通过遍历键集创建新类型，如 type Readonly<T> = { readonly [K in keyof T]: T[K] }。"},
        {"role": "user", "content": "怎么实现 DeepPartial？"},
    ],
    [
        {"role": "user", "content": "解释 TypeScript 映射类型"},
        {"role": "assistant", "content": "映射类型通过遍历键集创建新类型，如 type Readonly<T> = { readonly [K in keyof T]: T[K] }。"},
        {"role": "user", "content": "怎么实现 DeepPartial？"},
        {"role": "assistant", "content": "DeepPartial 递归地将嵌套对象变为可选，用条件类型判断值是否为对象后递归。"},
        {"role": "user", "content": "Key Remapping 怎么用？"},
    ],
    [
        {"role": "user", "content": "解释 TypeScript 映射类型"},
        {"role": "assistant", "content": "映射类型通过遍历键集创建新类型，如 type Readonly<T> = { readonly [K in keyof T]: T[K] }。"},
        {"role": "user", "content": "怎么实现 DeepPartial？"},
        {"role": "assistant", "content": "DeepPartial 递归地将嵌套对象变为可选，用条件类型判断值是否为对象后递归。"},
        {"role": "user", "content": "Key Remapping 怎么用？"},
        {"role": "assistant", "content": "Key Remapping 用 as 子句转换键名。"},
        {"role": "user", "content": "模板字面量在映射类型中的高级用法？"},
    ],
]

HOOK_ROUNDS = [
    [{"role": "user", "content": "用 TypeScript 实现一个 useDebounce hook"}],
    [
        {"role": "user", "content": "用 TypeScript 实现一个 useDebounce hook"},
        {"role": "assistant", "content": "useDebounce 用 useRef 存储 timeout，在 effect 中清理并重新设置延迟回调。"},
        {"role": "user", "content": "再加一个 useThrottle 版本"},
    ],
    [
        {"role": "user", "content": "用 TypeScript 实现一个 useDebounce hook"},
        {"role": "assistant", "content": "useDebounce 用 useRef 存储 timeout，在 effect 中清理并重新设置延迟回调。"},
        {"role": "user", "content": "再加一个 useThrottle 版本"},
        {"role": "assistant", "content": "useThrottle 记录上次执行时间戳，delay 间隔内返回缓存值，超过间隔才更新。"},
        {"role": "user", "content": "这两个 hook 有什么性能陷阱？"},
    ],
]


# ─── 测试函数 ──────────────────────────────────────────

def _separator(logger: Logger, title: str):
    logger.log(f"{'=' * 60}")
    logger.log(f"  {title}")
    logger.log(f"{'=' * 60}")


def test_anthropic_prefix(logger: Logger, interval: float):
    """测试1: 无缓存参数，多轮递增 + 完全重复"""
    test_name = "anthropic-prefix"
    logger.open_test_log(test_name)
    system = build_system_prompt()

    _separator(logger, "测试1: Anthropic Prefix Cache (无缓存参数)")
    logger.log(f"endpoint: {ANTHROPIC_URL}")
    logger.log(f"system prompt 时间戳: {system[:30]}...")
    logger.log("每轮追加消息，观察相同前缀是否能命中 cache_read\n")

    # 轮次1-3: 递增追加
    for i, msgs in enumerate(BUS_ROUNDS, 1):
        desc = f"{len(msgs)}条消息 -- {'初始请求' if i == 1 else f'前缀不变，追加第{i}轮'}"
        logger.log(f"[轮次{i}] {desc}")
        resp, code, latency = anthropic_request(system, msgs)
        body = {"model": "kimi-for-coding", "max_tokens": 128, "system": system, "messages": msgs}
        logger.record(test_name, i, "anthropic", ANTHROPIC_URL, code, latency, body, resp)
        logger.print_usage(resp)
        time.sleep(interval)

    # 轮次4: 完全重复轮次3
    logger.log(f"[轮次4] {len(BUS_ROUNDS[-1])}条消息 -- 与轮次3完全相同")
    resp, code, latency = anthropic_request(system, BUS_ROUNDS[-1])
    body = {"model": "kimi-for-coding", "max_tokens": 128, "system": system, "messages": BUS_ROUNDS[-1]}
    logger.record(test_name, 4, "anthropic", ANTHROPIC_URL, code, latency, body, resp)
    logger.print_usage(resp)

    logger.log("\n测试1完成")
    logger.close_test_log()


def test_anthropic_cache_control(logger: Logger, interval: float):
    """测试2: cache_control breakpoint 机制"""
    test_name = "anthropic-cache-control"
    logger.open_test_log(test_name)
    system = build_system_prompt()

    _separator(logger, "测试2: Anthropic cache_control Breakpoint")
    logger.log(f"endpoint: {ANTHROPIC_URL}")
    logger.log('system 带 cache_control: {"type": "ephemeral"}\n')

    # 轮次1-2: 只有 system 带 cache_control
    for i, msgs in enumerate(HOOK_ROUNDS[:2], 1):
        cache_msg = "system 带 cache_control"
        if i == 2:
            cache_msg += " + 追加消息"
        logger.log(f"[轮次{i}] {len(msgs)}条消息 -- {cache_msg}")
        resp, code, latency = anthropic_request_array_system(system, msgs)
        body = {"model": "kimi-for-coding", "max_tokens": 128, "messages": msgs, "system_array": True}
        logger.record(test_name, i, "anthropic", ANTHROPIC_URL, code, latency, body, resp)
        logger.print_usage(resp)
        time.sleep(interval)

    # 轮次3: assistant 也带 cache_control
    logger.log(f"[轮次3] {len(HOOK_ROUNDS[2])}条消息 -- system + assistant 都带 cache_control")
    resp, code, latency = anthropic_request_array_system(system, HOOK_ROUNDS[2], cache_in_messages=True)
    body = {"model": "kimi-for-coding", "max_tokens": 128, "messages": HOOK_ROUNDS[2], "system_array": True, "cache_in_messages": True}
    logger.record(test_name, 3, "anthropic", ANTHROPIC_URL, code, latency, body, resp)
    logger.print_usage(resp)

    logger.log("\n测试2完成")
    logger.close_test_log()


def test_anthropic_cache_key(logger: Logger, interval: float):
    """测试3: prompt_cache_key 有无对比"""
    test_name = "anthropic-cache-key"
    logger.open_test_log(test_name)
    system = build_system_prompt()

    _separator(logger, "测试3: Anthropic + prompt_cache_key (有无对比)")
    logger.log(f"endpoint: {ANTHROPIC_URL}")

    # Part A: 无 key
    logger.log("\n-- Part A: 无 prompt_cache_key --\n")
    for i, msgs in enumerate(CONDITION_ROUNDS, 1):
        logger.log(f"[轮次{i}] {len(msgs)}条消息 -- 无 key")
        resp, code, latency = anthropic_request(system, msgs)
        body = {"model": "kimi-for-coding", "max_tokens": 128, "system": system, "messages": msgs}
        logger.record(f"{test_name}-no-key", i, "anthropic", ANTHROPIC_URL, code, latency, body, resp)
        logger.print_usage(resp)
        time.sleep(interval)

    # Part B: 有 key (用新的 system prompt，因为前面请求已经可能影响缓存)
    system_b = build_system_prompt()
    logger.log(f'\n-- Part B: 带 prompt_cache_key="cache-test-session-001" --')
    logger.log(f"(Part B 使用新的 system prompt 时间戳以确保独立性)\n")
    for i, msgs in enumerate(MAPPED_ROUNDS, 1):
        logger.log(f"[轮次{i}] {len(msgs)}条消息 -- 带 key")
        extra = {"prompt_cache_key": "cache-test-session-001"}
        resp, code, latency = anthropic_request(system_b, msgs, extra=extra)
        body = {"model": "kimi-for-coding", "max_tokens": 128, "system": system_b, "messages": msgs, **extra}
        logger.record(f"{test_name}-with-key", i, "anthropic", ANTHROPIC_URL, code, latency, body, resp)
        logger.print_usage(resp)
        time.sleep(interval)

    logger.log("\n测试3完成")
    logger.close_test_log()


# ─── 测试调度 ──────────────────────────────────────────

TEST_MAP = {
    "anthropic-prefix": test_anthropic_prefix,
    "anthropic-cache-control": test_anthropic_cache_control,
    "anthropic-cache-key": test_anthropic_cache_key,
}


def main():
    global API_KEY

    parser = argparse.ArgumentParser(description="Kimi API 缓存命中率测试")
    parser.add_argument("tests", nargs="*", default=["all"], help="要运行的测试名 (默认 all)")
    parser.add_argument("--key", "-k", help="API Key (或设置 KIMI_API_KEY 环境变量)")
    parser.add_argument("--interval", "-i", type=float, default=2, help="请求间隔秒数 (默认 2)")
    args = parser.parse_args()

    API_KEY = args.key or os.environ.get("KIMI_API_KEY", "")
    if not API_KEY:
        print(f"{RED}错误: 请设置 KIMI_API_KEY 环境变量或传入 --key{RESET}")
        sys.exit(1)

    if "all" in args.tests:
        selected = ALL_TESTS
    else:
        selected = [t for t in args.tests if t in TEST_MAP]
        unknown = [t for t in args.tests if t not in TEST_MAP]
        if unknown:
            print(f"{RED}未知测试: {unknown}，可选: {ALL_TESTS}{RESET}")
            sys.exit(1)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    log_dir = Path(__file__).parent / "logs" / timestamp
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = Logger(log_dir)

    print(f"{BOLD}Kimi API 缓存命中率测试{RESET}")
    print(f"日志目录: {log_dir}")
    print(f"API Key: {API_KEY[:12]}...")
    print(f"请求间隔: {args.interval}s")
    print(f"测试: {selected}")

    for t in selected:
        try:
            TEST_MAP[t](logger, args.interval)
        except Exception as e:
            logger.log(f"{RED}测试 {t} 异常: {e}{RESET}")

    print("\n生成汇总报告...")
    report_path = logger.generate_report()
    logger.close()

    print(f"\n{GREEN}{BOLD}全部测试完成{RESET}")
    print(f"  日志目录: {log_dir}")
    print(f"  汇总 JSONL: {log_dir / 'requests.jsonl'}")
    print(f"  汇总报告: {report_path}")
    for t in selected:
        test_dir = log_dir / t
        if test_dir.exists():
            count = len(list(test_dir.glob("round_*.json")))
            print(f"  {t}: {count} 个请求详情 (test.log + round_*.json)")
    print(f"\n查看报告: cat {report_path}")


if __name__ == "__main__":
    main()
