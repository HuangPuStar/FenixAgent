---
name: use-opensandbox-sandbox
description: 通过 OpenSandbox Cluster 申请并使用沙盒，执行命令、上传下载文件，完成后销毁并释放资源。用于远程沙盒任务、运行脚本、传文件，支持数量模式和资源模式。
---

# 申请与使用 OpenSandbox 沙盒

通过 Cluster 调度到现有节点，然后通过 `proxy_url` 访问真实沙盒。部署机器和注册节点属于另一个技能，本技能使用现有资源池。

## 1. 准备输入

获取 `CLUSTER_URL`、`CLUSTER_SERVICE_API_KEY`、资源池、镜像、启动命令、CPU 核数（可小数）、内存 MB、硬盘 GB、GPU 数量，以及任务需要的使用时间、文件与命令。优先读取用户已提供的配置，只问缺失项。

请求统一带 `Authorization: Bearer <CLUSTER_SERVICE_API_KEY>`。密钥只从安全配置/环境读取，不写入回复、任务文件或命令跟踪；API 参数可查询 `{CLUSTER_URL}/openapi/json`。

1. `GET /api/v1/pools` 或 `GET /api/v1/pools/{poolId}` 确认池及 `schedulingMode`。
2. 为本任务确定唯一业务 `sandbox_id`，记录池、请求参数和创建结果。继续已有任务时先查询原记录，不重新申请。
3. 资源不足时报告需求和单节点余量，不把多个节点容量相加，也不擅自减少资源。

## 2. 按池模式创建

读取 [创建与销毁 API](references/lifecycle.md)，只执行选中池对应的分支：

- `resources`：`POST /api/v2/pools/{poolId}/sandboxes`，配置有限的 `lease_seconds` 和四项资源；省略租期时使用池默认值。`201` 可继续，`202` 先查询到 `active`。
- `count`：先分配绑定，再调用返回的代理创建 OpenSandbox 沙盒。使用条件创建头保护已有 ID，并给原生请求设置有限 `timeout`（秒，至少 60）。

创建响应未知、超时或 `uncertain` 时，按原业务 ID 查询并向用户报告进度；不换 ID 重放创建。资源模式同一 ID/相同参数可查询或幂等重试，但不能借此续租；数量模式原生创建不保证幂等。

保存以下信息用于后续访问和释放：

- `sandbox_id`：Cluster 业务 ID。
- `provider_sandbox_id`：节点真实 ID；数量模式原生创建响应字段为 `id`。
- `proxy_url`：相对 Cluster 的代理路径。
- 模式、到期时间、分配代次 `allocation_etag`（数量模式后续释放前重新查询）。

## 3. 执行命令与传文件

读取 [命令与文件操作](references/access.md) 的 curl 示例。

```text
原生状态：{proxy_url}/v1/sandboxes/{provider_sandbox_id}
execd 根路径：{proxy_url}/v1/sandboxes/{provider_sandbox_id}/proxy/44772
命令：POST {execd}/command
上传：POST {execd}/files/upload
下载：GET  {execd}/files/download?path=<沙盒文件路径>
```

请求地址为 Cluster 根地址加上述相对路径，仍使用 Cluster 密钥。业务 ID 和真实 ID 不能互换；通过 OpenSandbox 接口访问，无需安装 sshd。

1. 先查询原生状态，并检查 `{execd}/ping`。沙盒就绪后再发送任务。
2. 命令用 JSON，响应为 SSE；读取完成事件和退出码，HTTP 200 不代表命令成功。命令 `timeout` 的单位是毫秒，与沙盒使用期限的秒不同。
3. 上传用 multipart，`metadata` 是带 `filename=metadata.json` 的 JSON 文件 part，随后是 `file` part。普通文本表单字段会被节点拒绝。
4. 下载使用 URL 编码的 `path` 并保存二进制内容；写本地文件前确认不会覆盖用户数据。
5. 暂停会继续占用资源且不延长租期；需要保存产物时先下载，再销毁。

## 4. 完成后销毁

任务完成或失败后，默认清理本任务创建的沙盒，超时销毁仅作为兜底。用户要求保留时明确到期时间和后续删除方式；不销毁复用的已有沙盒，除非用户要求。

- 资源模式：`DELETE /api/v2/sandboxes/{sandboxId}`；`204` 完成，`202` 继续查询回收状态。到期回收留下的终态记录可再次 DELETE 清理。
- 数量模式：通过代理 DELETE 真实沙盒，再 GET 确认 `404`，最后重新查询绑定并携带其最新 ETag 释放。节点超时销毁后仍需释放绑定。

没有确认远端销毁时保留绑定，不先释放资源制造漏记。失败清理要报告剩余沙盒 ID、状态和下一步处理方式。

交付任务结果、命令退出状态、产物保存位置及清理结果；仍保留沙盒时给出业务 ID、真实 ID、到期时间和删除接口，不输出密钥。
