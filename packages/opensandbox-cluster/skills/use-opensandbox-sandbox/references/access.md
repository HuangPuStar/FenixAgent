# 命令与文件操作

下例在调用方机器执行，需 `curl`，并先通过环境安全提供 `CLUSTER_SERVICE_API_KEY`。将地址及 ID 换成创建结果；不使用主服务平台的 API Key 代替 Cluster 密钥。

```sh
CLUSTER_URL="http://cluster.example.com:8080"
PROXY_URL="/api/v1/sandboxes/<业务ID>/proxy"
PROVIDER_SANDBOX_ID="<真实ID>"
SANDBOX_URL="${CLUSTER_URL%/}$PROXY_URL/v1/sandboxes/$PROVIDER_SANDBOX_ID"
EXECD_URL="$SANDBOX_URL/proxy/44772"

curl --fail-with-body --silent --show-error "$SANDBOX_URL" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY"
curl --fail-with-body --silent --show-error "$EXECD_URL/ping" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY"
```

直接使用响应中的 `proxy_url`，不要自行从真实 ID 构造业务绑定路径。原生状态可为 `Running`、`Paused` 等，绑定的 `active` 只表示 Cluster 已关联沙盒，不等于进程在运行。就绪查询可间隔 2 秒尝试 15 次，超时后诊断并报告。

## 执行命令

```sh
curl --fail-with-body --silent --show-error -N "$EXECD_URL/command" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello","background":false,"timeout":30000}'
```

`command` 是沙盒 shell 命令，可提供 `cwd`。外部输入需作为参数安全引用或通过上传脚本传入，不拼接成可执行命令。`timeout` 是毫秒。响应为 `text/event-stream`：读取 SSE 的 stdout/stderr、完成事件及退出码，不对完整响应直接调用 JSON.parse。流中断属于执行结果未知，先检查产物/进程，避免重复执行有副作用的任务。

暂停/恢复：`POST $SANDBOX_URL/pause`、`POST $SANDBOX_URL/resume`，可返回空 body；随后查询原生状态。

## 上传文件

本地先准备 `hello.txt`；沙盒中的目标目录须存在。multipart 中 `metadata` 必须带 filename，发送为文件 part，并位于 `file` 前。

```sh
curl --fail-with-body --silent --show-error "$EXECD_URL/files/upload" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \
  -F 'metadata={"path":"/tmp/hello.txt"};type=application/json;filename=metadata.json' \
  -F 'file=@./hello.txt;type=application/octet-stream'
```

按任务替换本地文件和目标路径；多文件按 metadata/file 成对发送。不要将路径包含的引号、分号等直接拼进 curl form 字符串，复杂路径使用能构造 multipart 的 HTTP 客户端。

## 下载文件

```sh
curl --fail-with-body --silent --show-error -G "$EXECD_URL/files/download" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \
  --data-urlencode 'path=/tmp/hello.txt' \
  -o ./downloaded-hello.txt
```

对有价值的产物核对大小或校验和，再执行销毁。下载不是共享宿主机目录，文件路径相对于沙盒文件系统。
