# P0：Chat relay 误判长任务超时

## 时间

2026-09-10

## 事故简述

Chat relay 在 `send_prompt` 后连续 5 分钟未收到业务帧或 JSON-RPC 结果时，主动将请求标记为超时。长时间且中途无输出的 Bash 仍在正常执行，却被错误收敛为 `turn_failed`，导致用户看到虚假失败。该超时越权判断 Agent 生命周期，现已完整删除，终态仅以 Agent 返回、断连或显式取消为准。
