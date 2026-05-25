#!/usr/bin/env python3
"""
Workflow YAML 验证器
用法: python3 validate-workflow.py <file.yaml> [file2.yaml ...]

检查规则参照 .agents/skills/workflow-yaml-create/SKILL.md 编写检查清单。
"""

import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("需要 pyyaml: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

# ── 常量 ──

VALID_TYPES = {"shell", "python", "agent", "api", "audit", "workflow", "loop"}
NODES_WITH_INPUTS = {"shell", "python"}
NODES_WITH_ENV = {"shell", "python"}
VALID_PARAM_TYPES = {"string", "number", "boolean", "object"}
VALID_METHODS = {"GET", "POST", "PUT", "DELETE"}
VALID_BACKOFF = {"fixed", "exponential"}
TEMPLATE_PATTERN = re.compile(r"\$\{\{\s*(.+?)\s*\}\}")
NODES_REF_PATTERN = re.compile(r"\bnodes\.([a-zA-Z_]\w*)\b")
# inputs 表达式合法前缀
INPUTS_EXPR_VALID_PREFIXES = ("params.", "secrets.", "nodes.")

# ── 结果收集 ──

class Result:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str):
        self.errors.append(msg)

    def warn(self, msg: str):
        self.warnings.append(msg)

    @property
    def ok(self) -> bool:
        return len(self.errors) == 0

# ── 校验函数 ──

def validate_root(doc: dict, r: Result):
    """校验 YAML 根结构"""
    if "schema_version" not in doc:
        r.error("缺少必填字段 schema_version")
    elif doc["schema_version"] != "1":
        r.error(f'schema_version 必须是字符串 "1"，当前值: {json.dumps(doc["schema_version"])}')

    if "name" not in doc:
        r.error("缺少必填字段 name")
    elif not doc["name"] or not str(doc["name"]).strip():
        r.error("name 不能为空字符串")

    if "nodes" not in doc:
        r.error("缺少必填字段 nodes")
    elif not isinstance(doc["nodes"], list):
        r.error("nodes 必须是数组")
    elif len(doc["nodes"]) == 0:
        r.error("nodes 数组不能为空")

    if "timeout" in doc:
        t = doc["timeout"]
        if not isinstance(t, (int, float)) or t <= 0:
            r.error(f"timeout 必须是正数，当前值: {json.dumps(t)}")

    # params 类型声明检查
    params = doc.get("params")
    if isinstance(params, dict):
        for pname, pdef in params.items():
            if isinstance(pdef, dict) and "type" in pdef:
                if pdef["type"] not in VALID_PARAM_TYPES:
                    r.error(f'params.{pname}.type 无效值 "{pdef["type"]}"，合法值: {", ".join(sorted(VALID_PARAM_TYPES))}')


def validate_node_base(node: dict, r: Result, idx: int) -> str | None:
    """校验节点基础字段，返回 node id"""
    prefix = f"nodes[{idx}]"

    node_id = node.get("id")
    if not node_id:
        r.error(f"{prefix}: 缺少必填字段 id")
        return None
    if not isinstance(node_id, str):
        r.error(f"{prefix}: id 必须是字符串")
        return None

    prefix = f'{prefix} id="{node_id}"'

    if "-" in node_id:
        r.warn(f"{prefix}: 节点 ID 含连字符，建议用下划线（如 gen_data）以避免表达式解析问题")

    node_type = node.get("type")
    if not node_type:
        r.error(f"{prefix}: 缺少必填字段 type")
        return node_id
    if node_type not in VALID_TYPES:
        r.error(f'{prefix}: 无效节点类型 "{node_type}"，合法值: {", ".join(sorted(VALID_TYPES))}')

    desc = node.get("description")
    if not desc or not str(desc).strip():
        r.error(f"{prefix}: 缺少必填字段 description（每个节点都必须写描述）")

    # timeout 类型检查
    if "timeout" in node:
        t = node["timeout"]
        if not isinstance(t, (int, float)) or t <= 0:
            r.error(f"{prefix}: timeout 必须是正数，当前值: {json.dumps(t)}")

    # retry 结构检查
    retry = node.get("retry")
    if retry is not None:
        if not isinstance(retry, dict):
            r.error(f"{prefix}: retry 必须是对象 {{count, delay?, backoff?}}")
        else:
            if "count" not in retry:
                r.error(f"{prefix}: retry 缺少必填字段 count")
            elif not isinstance(retry["count"], int) or retry["count"] < 0:
                r.error(f'{prefix}: retry.count 必须是非负整数，当前值: {json.dumps(retry["count"])}')
            if "delay" in retry and not isinstance(retry["delay"], (int, float)):
                r.error(f'{prefix}: retry.delay 必须是数字')
            if "backoff" in retry and retry["backoff"] not in VALID_BACKOFF:
                r.error(f'{prefix}: retry.backoff 无效值 "{retry["backoff"]}"，合法值: {", ".join(sorted(VALID_BACKOFF))}')

    return node_id


def validate_node_type_fields(node: dict, r: Result, node_id: str):
    """校验各节点类型的特有必填字段 + 字段类型"""
    prefix = f'id="{node_id}"'
    t = node.get("type")

    type_required = {
        "shell": [("command", "command（字符串或字符串数组）")],
        "python": [("code", "code（Python 代码）")],
        "agent": [("prompt", "prompt（提示词）")],
        "api": [("url", "url（请求地址）")],
        "workflow": [("ref", "ref（子工作流引用路径）")],
        "loop": [("condition", "condition（循环条件）"), ("max_iterations", "max_iterations（最大迭代次数）"), ("body", "body（子 DAG）")],
    }

    for field, label in type_required.get(t, []):
        if field not in node or node[field] is None:
            r.error(f"{prefix}: {t} 节点缺少必填字段 {label}")

    # ── 字段类型检查 ──

    if t == "shell":
        cmd = node.get("command")
        if cmd is not None and not isinstance(cmd, (str, list)):
            r.error(f"{prefix}: command 必须是字符串或字符串数组")
        elif isinstance(cmd, list):
            for i, part in enumerate(cmd):
                if not isinstance(part, str):
                    r.error(f"{prefix}: command[{i}] 必须是字符串")

    if t == "api":
        method = node.get("method")
        if method is not None:
            if isinstance(method, str) and method.upper() not in VALID_METHODS:
                r.error(f'{prefix}: method 无效值 "{method}"，合法值: {", ".join(sorted(VALID_METHODS))}')
            elif not isinstance(method, str):
                r.error(f"{prefix}: method 必须是字符串")
        headers = node.get("headers")
        if headers is not None and not isinstance(headers, dict):
            r.error(f"{prefix}: headers 必须是 key-value 映射")

    if t == "loop":
        mi = node.get("max_iterations")
        if mi is not None and (not isinstance(mi, int) or mi <= 0):
            r.error(f"{prefix}: max_iterations 必须是正整数，当前值: {json.dumps(mi)}")
        body = node.get("body")
        if body is not None:
            if not isinstance(body, dict):
                r.error(f"{prefix}: body 必须是包含 nodes 数组的对象")
            elif "nodes" not in body or not isinstance(body["nodes"], list):
                r.error(f"{prefix}: body.nodes 必须是数组")
            else:
                # 递归检查 loop body 的节点基础字段
                for j, sub in enumerate(body["nodes"]):
                    if isinstance(sub, dict):
                        sub_id = sub.get("id")
                        if not sub_id:
                            r.error(f"{prefix}: body.nodes[{j}] 缺少 id")
                        sub_type = sub.get("type")
                        if sub_type and sub_type not in VALID_TYPES:
                            r.error(f'{prefix}: body.nodes[{j}] 无效类型 "{sub_type}"')
                        sub_desc = sub.get("description")
                        if not sub_desc or not str(sub_desc).strip():
                            r.error(f'{prefix}: body.nodes[{j}] id="{sub_id}" 缺少 description')

    if t == "audit":
        ei = node.get("expires_in")
        if ei is not None and (not isinstance(ei, (int, float)) or ei <= 0):
            r.error(f"{prefix}: expires_in 必须是正数，当前值: {json.dumps(ei)}")


def validate_inputs(node: dict, r: Result, node_id: str, all_ids: set[str]):
    """校验 inputs 字段"""
    prefix = f'id="{node_id}"'
    t = node.get("type")
    inputs = node.get("inputs")

    if inputs is None:
        return

    # inputs 只允许出现在 shell/python 节点
    if t not in NODES_WITH_INPUTS:
        r.error(f"{prefix}: {t} 节点不支持 inputs 字段，inputs 仅适用于 shell/python 节点")
        return

    if not isinstance(inputs, dict):
        r.error(f"{prefix}: inputs 必须是 key-value 映射")
        return

    depends_on = set(node.get("depends_on") or [])

    for key, expr in inputs.items():
        if not isinstance(expr, str):
            r.error(f"{prefix}: inputs.{key} 的值必须是字符串表达式，当前值: {json.dumps(expr)}")
            continue

        # 检查 inputs 值不含 ${{ }}
        if TEMPLATE_PATTERN.search(expr):
            r.error(prefix + ": inputs." + key + " 的值不应包含 ${{ }}，直接写表达式路径即可（如 params.xxx 或 nodes.xxx.output）")

        # 检查表达式路径合法性
        if not any(expr.startswith(p) for p in INPUTS_EXPR_VALID_PREFIXES):
            r.error(f'{prefix}: inputs.{key} 表达式 "{expr}" 无效，必须以 params. / secrets. / nodes. 开头')

        # 检查 nodes.<id> 引用是否在 depends_on 中
        for match in NODES_REF_PATTERN.finditer(expr):
            ref_id = match.group(1)
            if ref_id not in all_ids:
                r.error(f'{prefix}: inputs.{key} 引用了不存在的节点 "{ref_id}"')
            elif ref_id not in depends_on:
                r.error(f"{prefix}: inputs.{key} 引用了 nodes.{ref_id} 但未在 depends_on 中声明（INPUTS_MISSING_DEPENDENCY）")


def validate_env_field(node: dict, r: Result, node_id: str):
    """校验 env 字段"""
    prefix = f'id="{node_id}"'
    t = node.get("type")
    env = node.get("env")

    if env is None:
        return

    if not isinstance(env, dict):
        r.error(f"{prefix}: env 必须是 key-value 映射")
        return

    # env 对所有节点都是合法字段，但只有 shell/python 实际生效
    if t not in NODES_WITH_ENV:
        r.warn(f"{prefix}: {t} 节点的 env 字段不会生效，env 仅在 shell/python 节点中注入环境变量")

    for k, v in env.items():
        if not isinstance(v, str):
            r.error(f"{prefix}: env.{k} 的值必须是字符串，当前值: {json.dumps(v)}")


def validate_no_template_in_code(node: dict, r: Result, node_id: str):
    """校验 Shell/Python 节点的 command/code 不使用 ${{ }}"""
    prefix = f'id="{node_id}"'
    t = node.get("type")

    if t == "shell":
        command = node.get("command")
        if isinstance(command, str) and TEMPLATE_PATTERN.search(command):
            r.error(prefix + ": shell 节点的 command 中禁止使用 ${{ }} 模板，请改用 inputs 字段 + 环境变量")
        elif isinstance(command, list):
            for part in command:
                if isinstance(part, str) and TEMPLATE_PATTERN.search(part):
                    r.error(prefix + ": shell 节点的 command 中禁止使用 ${{ }} 模板，请改用 inputs 字段 + 环境变量")
                    break

    elif t == "python":
        code = node.get("code")
        if isinstance(code, str) and TEMPLATE_PATTERN.search(code):
            r.error(prefix + ": python 节点的 code 中禁止使用 ${{ }} 模板，请改用 inputs 字段 + Python 变量")


def validate_depends_on(node: dict, r: Result, node_id: str, all_ids: set[str]):
    """校验 depends_on 引用"""
    prefix = f'id="{node_id}"'
    depends_on = node.get("depends_on")

    if depends_on is None:
        return

    if not isinstance(depends_on, list):
        r.error(f"{prefix}: depends_on 必须是字符串数组")
        return

    for dep_id in depends_on:
        if not isinstance(dep_id, str):
            r.error(f"{prefix}: depends_on 中的元素必须是字符串")
        elif dep_id not in all_ids:
            r.error(f'{prefix}: depends_on 引用了不存在的节点 "{dep_id}"')

    # 检查 depends_on 中是否有重复
    seen_deps: set[str] = set()
    for dep_id in depends_on:
        if isinstance(dep_id, str):
            if dep_id in seen_deps:
                r.error(f'{prefix}: depends_on 中有重复引用 "{dep_id}"')
            seen_deps.add(dep_id)


def validate_duplicate_ids(nodes: list[dict], r: Result):
    """检查重复节点 ID"""
    seen: dict[str, int] = {}
    for i, node in enumerate(nodes):
        node_id = node.get("id")
        if not isinstance(node_id, str):
            continue
        if node_id in seen:
            r.error(f'nodes[{i}] id="{node_id}": 重复节点 ID（首次出现在 nodes[{seen[node_id]}]）')
        else:
            seen[node_id] = i


def validate_no_cycle(nodes: list[dict], r: Result):
    """检查循环依赖"""
    adj: dict[str, list[str]] = {}
    for node in nodes:
        nid = node.get("id")
        if isinstance(nid, str):
            adj[nid] = [d for d in (node.get("depends_on") or []) if isinstance(d, str)]

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {nid: WHITE for nid in adj}

    def dfs(node_id: str, path: list[str]) -> bool:
        color[node_id] = GRAY
        path.append(node_id)
        for dep in adj.get(node_id, []):
            if dep not in color:
                continue
            if color[dep] == GRAY:
                cycle_start = path.index(dep)
                cycle = path[cycle_start:] + [dep]
                r.error(f"检测到循环依赖: {' → '.join(cycle)}")
                return True
            if color[dep] == WHITE:
                if dfs(dep, path):
                    return True
        path.pop()
        color[node_id] = BLACK
        return False

    for nid in adj:
        if color[nid] == WHITE:
            if dfs(nid, []):
                break


# ── 主流程 ──

def validate_file(path: str) -> Result:
    r = Result()

    p = Path(path)
    if not p.exists():
        r.error(f"文件不存在: {path}")
        return r

    try:
        doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        r.error(f"YAML 解析失败: {e}")
        return r

    if not isinstance(doc, dict):
        r.error("YAML 根必须是映射（key-value）")
        return r

    # 1. 根结构
    validate_root(doc, r)

    # 缺少 nodes 或 nodes 不是数组就无法继续检查节点
    nodes = doc.get("nodes")
    if nodes is None or not isinstance(nodes, list):
        return r

    # 即使根结构有非致命错误（如 timeout/params 类型），也继续校验节点

    # 2. 重复 ID
    validate_duplicate_ids(nodes, r)

    # 收集所有 ID
    all_ids: set[str] = set()
    for node in nodes:
        nid = node.get("id")
        if isinstance(nid, str):
            all_ids.add(nid)

    # 3. 逐节点校验
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            r.error(f"nodes[{i}]: 节点必须是映射")
            continue

        node_id = validate_node_base(node, r, i)
        if node_id is None:
            continue

        validate_node_type_fields(node, r, node_id)
        validate_depends_on(node, r, node_id, all_ids)
        validate_inputs(node, r, node_id, all_ids)
        validate_env_field(node, r, node_id)
        validate_no_template_in_code(node, r, node_id)

    # 4. 循环依赖
    validate_no_cycle(nodes, r)

    return r


def main():
    if len(sys.argv) < 2:
        print("用法: python3 validate-workflow.py <file.yaml> [file2.yaml ...]", file=sys.stderr)
        sys.exit(2)

    all_ok = True
    for path in sys.argv[1:]:
        print(f"验证: {path}")
        r = validate_file(path)

        if r.warnings:
            for w in r.warnings:
                print(f"  ⚠️  {w}")

        if r.errors:
            all_ok = False
            for e in r.errors:
                print(f"  ❌ {e}")
            print(f"  结果: 失败（{len(r.errors)} 个错误）\n")
        else:
            print(f"  ✅ 通过\n")

    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
