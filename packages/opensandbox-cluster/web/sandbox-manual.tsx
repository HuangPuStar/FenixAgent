import { ApiCode, ApiHelp, Manual } from "./help";
import { t } from "./i18n";
import { SkillDownload } from "./skill-downloads";

/** End-to-end sandbox creation, proxy access and cleanup instructions. */
export function SandboxManual() {
  return (
    <Manual title={t("沙盒使用手册")}>
      <ApiHelp />
      <h3 className="text-base font-semibold">{t("1. 创建沙盒")}</h3>
      <p>
        <strong>{t("页面：")}</strong>
        {t(
          "点击「新建沙盒」，选择池，填写镜像、启动命令和资源配额后确认。资源模式可设置租期，留空使用池默认租期。创建后在列表查看配额、运行状态及到期时间。",
        )}
      </p>
      <p>
        <strong>{t("资源模式 API：")}</strong>
        {t(
          "一次请求完成节点分配与沙盒创建。返回 201 表示创建成功；失败会返回错误并清理本次预留，可能的残留可到节点页面通过「沙盒对账」检查和销毁。",
        )}
      </p>
      <ApiCode>{`POST /api/v2/pools/{poolId}/sandboxes
GET  /api/v2/sandboxes/{sandboxId}`}</ApiCode>
      <details>
        <summary className="cursor-pointer font-medium">{t("资源模式创建示例（JSON）")}</summary>
        <ApiCode>{`{
  "sandbox_id": "job-123",
  "lease_seconds": 3600,
  "resources": {
    "cpu": 0.5,
    "memoryMb": 512,
    "diskGb": 5,
    "gpuCount": 0
  },
  "sandbox": {
    "image": { "uri": "your-image:tag" },
    "entrypoint": ["sleep", "infinity"]
  }
}`}</ApiCode>
      </details>
      <p>
        <strong>{t("数量模式 API：")}</strong>
        {t(
          "先分配绑定获取 proxy_url，再通过它调用 OpenSandbox 原生创建接口。allocate 只分配节点，不会创建沙盒；原生创建响应中的 id 是真实沙盒 ID。",
        )}
      </p>
      <ApiCode>{`POST /api/v1/pools/{poolId}/sandboxes/{sandboxId}/allocate
POST {proxy_url}/v1/sandboxes
GET  /api/v1/sandboxes/{sandboxId}/allocation`}</ApiCode>
      <details>
        <summary className="cursor-pointer font-medium">{t("数量模式原生创建示例（JSON）")}</summary>
        <ApiCode>{`{
  "image": { "uri": "your-image:tag" },
  "entrypoint": ["sleep", "infinity"],
  "resourceLimits": { "cpu": "1", "memory": "512Mi", "disk": "5Gi", "gpu": "0" },
  "timeout": 3600
}`}</ApiCode>
      </details>
      <p>{t("按池或节点筛选列表可用 GET /api/v1/sandbox-allocations?pool_id={poolId}&page=1&pageSize=20。")}</p>

      <h3 className="text-base font-semibold">{t("2. 访问沙盒：命令与文件")}</h3>
      <p>
        {t(
          "在列表点击「详情」，获取 proxy_url 和 provider_sandbox_id。数量模式也可使用原生创建响应的 id。sandbox_id 是 Cluster 业务 ID，provider_sandbox_id 是节点真实 ID，访问时按下面的路径组合。",
        )}
      </p>
      <ApiCode>{`GET  {proxy_url}/v1/sandboxes/{provider_sandbox_id}
POST {proxy_url}/v1/sandboxes/{provider_sandbox_id}/proxy/44772/command
POST {proxy_url}/v1/sandboxes/{provider_sandbox_id}/proxy/44772/files/upload
GET  {proxy_url}/v1/sandboxes/{provider_sandbox_id}/proxy/44772/files/download?path=/tmp/hello.txt`}</ApiCode>
      <p>
        {t(
          "proxy_url 是相对路径，前面拼接 Cluster 地址；请求仍使用 Cluster 密钥。44772 是沙盒内 execd 的服务端口，镜像需要包含并启动 execd。",
        )}
      </p>
      <details>
        <summary className="cursor-pointer font-medium">{t("命令下发、文件上传与下载示例（curl）")}</summary>
        <p>
          {t(
            "先在终端设置 CLUSTER_URL 和 CLUSTER_SERVICE_API_KEY，再把 PROXY_URL、PROVIDER_SANDBOX_ID 替换为详情中的值。上传示例使用本地 hello.txt，目标路径为沙盒内的 /tmp/hello.txt。",
          )}
        </p>
        <ApiCode>{`CLUSTER_URL="http://localhost:8080"
PROXY_URL="/api/v1/sandboxes/job-123/proxy"
PROVIDER_SANDBOX_ID="<provider_sandbox_id>"
EXECD_URL="$CLUSTER_URL$PROXY_URL/v1/sandboxes/$PROVIDER_SANDBOX_ID/proxy/44772"

# 执行命令，输出为 SSE 流；此处 timeout 单位是毫秒
curl --fail-with-body -N "$EXECD_URL/command" \\
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"command":"echo hello","background":false,"timeout":30000}'

# 上传：metadata 也需要 filename，作为 JSON 文件 part 发送
curl --fail-with-body "$EXECD_URL/files/upload" \\
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \\
  -F 'metadata={"path":"/tmp/hello.txt"};type=application/json;filename=metadata.json' \\
  -F 'file=@./hello.txt;type=application/octet-stream'

# 下载
curl --fail-with-body -G "$EXECD_URL/files/download" \\
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \\
  --data-urlencode 'path=/tmp/hello.txt' \\
  -o ./downloaded-hello.txt`}</ApiCode>
      </details>

      <h3 className="text-base font-semibold">{t("3. 销毁沙盒")}</h3>
      <p>
        <strong>{t("建议用完立即销毁，超时回收作为兜底。")}</strong>
        {t("页面点击对应行的「删除」，会销毁远端沙盒并清理记录；「暂停」仍占用资源，不能代替销毁。")}
      </p>
      <p>
        <strong>{t("资源模式 API：")}</strong>
        {t(
          "调用下方 DELETE。返回 204 表示完成，202 表示回收中，可查询进度。租期到期会自动销毁，暂停或重试不会续租；到期后保留的终态记录可再次 DELETE 清理。",
        )}
      </p>
      <ApiCode>{`DELETE /api/v2/sandboxes/{sandboxId}`}</ApiCode>
      <p>
        <strong>{t("数量模式 API：")}</strong>
        {t("先删除真实沙盒，查询确认返回 404 后，再释放 Cluster 绑定；仅删除绑定不会销毁远端沙盒。")}
      </p>
      <ApiCode>{`DELETE {proxy_url}/v1/sandboxes/{provider_sandbox_id}
GET    {proxy_url}/v1/sandboxes/{provider_sandbox_id}
DELETE /api/v1/sandboxes/{sandboxId}/allocation`}</ApiCode>
      <p>
        {t(
          "数量模式的绑定没有租期。使用原生创建 API 时可设置 timeout（秒，至少 60）让节点兜底销毁；省略或为 null 时需要手动销毁。节点超时销毁后仍需释放 Cluster 绑定。当前页面创建数量模式沙盒不设置 timeout，请用完手动删除。",
        )}
      </p>
      <h3 className="text-base font-semibold">{t("4. 使用 Skill 让 Agent 申请和操作沙盒")}</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <SkillDownload name="use-opensandbox-sandbox" />
        </li>
        <li>
          {t(
            "将压缩包解压到使用方 Agent 的技能目录，保留 use-opensandbox-sandbox/SKILL.md 和 references。按 Agent 的方式重新加载技能；支持项目技能的 Agent 可安装到其工作项目的 .agents/skills/。",
          )}
        </li>
        <li>
          {t(
            "在 Agent 可读取的环境变量或安全配置中提供 CLUSTER_URL、CLUSTER_SERVICE_API_KEY。告知池 ID、镜像、启动命令、资源需求、使用时间，以及要执行的命令和传输的文件。",
          )}
        </li>
        <li>
          {t(
            "向 Agent 发送下面的指令并替换示例参数。Agent 会按池模式申请沙盒，通过代理执行任务、传输文件，最后销毁沙盒并释放资源。",
          )}
        </li>
      </ol>
      <ApiCode>
        {t(`使用 use-opensandbox-sandbox Skill，在 gpu-pool 中申请一个沙盒。
Cluster 地址和密钥从已配置的 CLUSTER_URL、CLUSTER_SERVICE_API_KEY 读取。
镜像为 <任务镜像:tag>，启动命令为 sleep infinity。
申请 0.5 核 CPU、512 MB 内存、5 GB 硬盘、0 个 GPU，使用时间 3600 秒。
将本地 ./hello.txt 上传到沙盒 /tmp/hello.txt，执行 cat /tmp/hello.txt，
再将它下载到本地 ./downloaded-hello.txt 并核对内容。
完成后销毁沙盒并释放资源，告诉我执行结果和清理结果。`)}
      </ApiCode>
      <p>{t("已有沙盒可提供业务 sandbox_id 让 Agent 继续使用；需要保留时明确告知，并记录到期时间和后续销毁方式。")}</p>
    </Manual>
  );
}
