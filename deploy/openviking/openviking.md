# OpenViking 配置使用指引

OpenViking 用作 RCS 的知识库服务，负责文档上传、索引和检索。

## 1. 创建配置文件

```bash
cp deploy/openviking/ov.conf.example deploy/openviking/ov.conf
```

编辑 `deploy/openviking/ov.conf`：

```json
{
  "server": {
    "host": "0.0.0.0",
    "root_api_key": "replace-with-a-long-random-secret"
  },
  "allow_private_networks": true,
  "storage": {
    "workspace": "/app/data"
  },
  "embedding": {
    "dense": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "api_key": "replace-with-embedding-key",
      "api_base": "https://api.openai.com/v1",
      "dimension": 1024
    }
  },
  "vlm": {
    "provider": "openai",
    "model": "gpt-4.1-mini",
    "api_base": "https://api.openai.com/v1",
    "temperature": 0.0,
    "max_retries": 2,
    "api_key": "replace-with-vlm-key"
  }
}
```

说明：

- `server.root_api_key`：OpenViking API Key，后面要填到 RCS 的 `RCS_KNOWLEDGE_API_KEY`。
- `storage.workspace`：建议使用 `/app/data`，与 `docker-compose.yml` 里的 `openviking-data:/app/data` 挂载保持一致。
- `embedding.dense.dimension`：必须和 embedding 模型实际输出维度一致。
- `allow_private_networks`：允许导入内网 URL，只建议在可信部署环境中开启。

## 2. 配置 RCS

Docker Compose 内部运行 RCS 时：

```bash
RCS_KNOWLEDGE_PROVIDER=openviking
RCS_KNOWLEDGE_BASE_URL=http://openviking:1933
RCS_KNOWLEDGE_API_KEY=replace-with-a-long-random-secret
```

本机运行 RCS、Docker 启动 OpenViking 时：

```bash
RCS_KNOWLEDGE_PROVIDER=openviking
RCS_KNOWLEDGE_BASE_URL=http://localhost:1933
RCS_KNOWLEDGE_API_KEY=replace-with-a-long-random-secret
```

`RCS_KNOWLEDGE_API_KEY` 必须和 `ov.conf` 里的 `server.root_api_key` 一致。

## 3. 启动

只启动 OpenViking：

```bash
docker compose --profile openviking up -d openviking
```

生产环境和 RCS 一起启动：

```bash
docker compose --profile openviking -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

## 4. 检查

```bash
docker compose ps openviking
curl -fsS http://localhost:1933/health
```

服务正常后，在 RCS 控制台创建知识库、上传文件或导入 URL，再把知识库绑定到 Agent 即可使用。
