# 服务器磁盘 IO 打满故障

## 时间

2026-07-23

## 现象

服务器响应缓慢，Docker stats 卡死，`vmstat` 显示磁盘 IO wait 高达 45%~65%，280+ 进程处于 D 状态阻塞。

## 根因

`docker-454a546f4b88...` 容器内有 **65 个 `/usr/local/bin/opencode acp` 进程**同时运行，最长已运行 **26 小时**。这些进程大规模读取磁盘（~140MB/s 纯读），耗尽 NVMe IOPS。

## 排查过程

| 步骤 | 发现问题 | 工具 |
|------|---------|------|
| 1 | df -h 磁盘空间正常（16%），排除空间满 | `df -h` |
| 2 | iostat 显示 nvme0n1 纯读 142MB/s，%util 30.8% | `iostat -dx` |
| 3 | vmstat wa 45%~65%，b 列 280+ 进程排队等 IO | `vmstat 1` |
| 4 | Dockerd read_bytes 累计 338GB，怀疑容器日志 | `cat /proc/$(pidof dockerd)/io` |
| 5 | lsof 确认 dockerd FD22 正写 agent-sites-1 日志 | `lsof -p $(pidof dockerd)` |
| 6 | 杀 agent-sites-1 后 IO 未降，排除该容器 | `kill -9` shim |
| 7 | ps aux \| grep D 发现 65 个 opencode 进程全在 D 状态 | `ps aux` |
| 8 | 65 个 opencode 全属于 docker-454a54... 容器 | `cat /proc/$pid/cgroup` |
| 9 | 杀容器后 wa 降至 0%，可用内存从 3.9GB 恢复至 18.3GB | `vmstat 1` |

## 解决

```bash
# 找到 opencode 容器的 shim 并杀掉
CID="454a546f4b88"
SHIM=$(ps -eo pid,args | grep "containerd-shim.*$CID" | grep -v grep | awk '{print $1}' | head -1)
ps --ppid $SHIM -o pid --no-headers | xargs kill -9
kill -9 $SHIM
# 兜底清理残余 opencode
ps -eo pid,args | grep "/usr/local/bin/opencode" | grep -v grep | awk '{print $1}' | xargs kill -9
```

## 效果

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| IO wait (wa) | 65% | 0% |
| 阻塞进程 (b) | 289 | 0 |
| 磁盘读 (bi) | 140 MB/s | ~0 MB/s |
| 可用内存 | 3.9 GB | 18.3 GB |

## 预防

1. **限制 opencode 并发数**：在应用层限制单容器内 opencode ACP session 数量
2. **超时自动终止**：opencode session 超过 N 小时自动 kill
3. **容器 IO 限制**：docker compose 加 `blkio_config` 限制每容器读写带宽
4. **监控告警**：`wa > 30%` 持续 5 分钟触发告警（Prometheus node_exporter + AlertManager）

## 相关文件

- `kill-agent-sites.sh` — agent-sites 容器清理脚本
- `kill-opencode.sh` — opencode 容器清理脚本
