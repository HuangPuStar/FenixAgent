#!/bin/bash
CONTAINER_ID="454a546f4b88c3ba0ac845b9f6cef376e854d4bbc1ccd0298136c46fb4023f04"
SID="${CONTAINER_ID:0:12}"

echo "=== 1. 查 containerd-shim ==="
shim_pids=$(ps -eo pid,args | grep "containerd-shim.*$SID" | grep -v grep | awk '{print $1}')
echo "shim PIDs: $shim_pids"

echo ""
echo "=== 2. 查看 opencode 子进程数量 ==="
for sp in $shim_pids; do
    child_count=$(ps --ppid $sp -o pid --no-headers 2>/dev/null | wc -l | tr -d ' ')
    echo "  shim PID=$sp  子进程数=$child_count"
    ps --ppid $sp -o pid,args --no-headers 2>/dev/null | head -3 | sed 's/^/    /'
done

echo ""
echo "=== 3. 杀所有 opencode 子进程 ==="
count=0
for sp in $shim_pids; do
    for cp in $(ps --ppid $sp -o pid --no-headers 2>/dev/null); do
        kill -9 $cp 2>/dev/null && count=$((count+1))
    done
done
echo "  已杀子进程: $count 个"

echo ""
echo "=== 4. 杀 shim 自身 ==="
for sp in $shim_pids; do
    kill -9 $sp 2>/dev/null && echo "  killed shim PID=$sp"
done

echo ""
echo "=== 5. 兜底杀所有残余 opencode ==="
opencode_pids=$(ps -eo pid,args | grep "/usr/local/bin/opencode" | grep -v grep | awk '{print $1}')
remain=$(echo "$opencode_pids" | grep -c .)
echo "  残余 opencode 进程: $remain 个"
for pid in $opencode_pids; do
    kill -9 $pid 2>/dev/null
done
echo "  已清理"

echo ""
echo "=== 6. 验证 IO 恢复 ==="
sleep 3
vmstat 1 5
