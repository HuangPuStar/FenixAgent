#!/bin/bash
# 查找容器的完整 ID 和短 ID，方便给 kill-opencode.sh 使用
# 用法: ./find-container.sh [keyword]

KEYWORD="${1:-opencode}"

echo "=== 搜索关键词: $KEYWORD ==="
echo ""

found=0

# --- 方法 1: crictl (containerd / k8s) ---
if command -v crictl &>/dev/null; then
    echo "--- crictl ps ---"
    while IFS= read -r line; do
        cid=$(echo "$line" | awk '{print $1}')
        cname=$(echo "$line" | awk '{for(i=6;i<=NF;i++) printf "%s ", $i; print ""}' | sed 's/ *$//')
        if echo "$cname" | grep -qi "$KEYWORD"; then
            sid="${cid:0:12}"
            echo "  NAME: $cname"
            echo "  FULL_ID: $cid"
            echo "  SID(前12): $sid"
            echo "---"
            found=$((found + 1))
        fi
    done < <(crictl ps -a 2>/dev/null | tail -n +2)
fi

# --- 方法 2: ctr (containerd) ---
if command -v ctr &>/dev/null; then
    echo "--- ctr containers ---"
    while IFS= read -r line; do
        cid=$(echo "$line" | awk '{print $1}')
        # ctr 可能会在末尾显示容器名
        rest=$(echo "$line" | awk '{for(i=2;i<=NF;i++) printf "%s ", $i; print ""}')
        if echo "$rest" | grep -qi "$KEYWORD"; then
            sid="${cid:0:12}"
            echo "  FULL_ID: $cid"
            echo "  SID(前12): $sid"
            echo "  INFO: $rest"
            echo "---"
            found=$((found + 1))
        fi
    done < <(ctr containers ls 2>/dev/null | tail -n +2)
fi

# --- 方法 3: 从 containerd-shim 进程反查，匹配子进程关键词 ---
shim_pids=$(ps -eo pid,args | grep "containerd-shim" | grep -v grep | awk '{print $1}')
if [ -n "$shim_pids" ]; then
    echo "--- containerd-shim (子进程匹配 '$KEYWORD') ---"
    for pid in $shim_pids; do
        cmdline=$(ps -p $pid -o args --no-headers 2>/dev/null)
        # containerd-shim 参数里通常带有容器 id
        # 格式如: containerd-shim -namespace moby -id <container_id> ...
        cid=$(echo "$cmdline" | grep -oP '\-id\s+\K\S+')
        if [ -z "$cid" ]; then
            # 尝试匹配 64 位 hex 字符串
            cid=$(echo "$cmdline" | grep -oP '[a-f0-9]{64}')
        fi
        if [ -n "$cid" ]; then
            # 查找子进程中是否有匹配关键词的
            matched_child=$(ps --ppid $pid -o args --no-headers 2>/dev/null | grep -i "$KEYWORD" | grep -v grep | head -1)
            if [ -n "$matched_child" ]; then
                sid="${cid:0:12}"
                child_count=$(ps --ppid $pid -o pid --no-headers 2>/dev/null | wc -l | tr -d ' ')
                echo "  PID=$pid  FULL_ID=$cid  SID=$sid  子进程数=$child_count"
                echo "    匹配进程: $matched_child"
                echo "---"
                found=$((found + 1))
            fi
        fi
    done
fi

# --- 方法 4: docker ---
if command -v docker &>/dev/null; then
    echo "--- docker ps ---"
    while IFS= read -r line; do
        cid=$(echo "$line" | awk '{print $1}')
        cname=$(echo "$line" | awk '{print $NF}')
        if echo "$cname" | grep -qi "$KEYWORD"; then
            sid="${cid:0:12}"
            echo "  NAME: $cname"
            echo "  FULL_ID: $cid"
            echo "  SID(前12): $sid"
            echo "---"
            found=$((found + 1))
        fi
    done < <(docker ps -a --format '{{.ID}} {{.Names}}' 2>/dev/null)
fi

echo ""
if [ $found -eq 0 ]; then
    echo "未找到匹配 '$KEYWORD' 的容器。"
    echo "可指定其他关键词重试: $0 <keyword>"
else
    echo "找到 $found 个匹配容器，将对应 FULL_ID 填入 kill-opencode.sh 的 CONTAINER_ID 即可。"
fi
