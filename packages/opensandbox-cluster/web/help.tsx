import type { ReactNode } from "react";
import { t } from "./i18n";
import { SkillDownload } from "./skill-downloads";

/** Document-style guidance kept below the resource's working area. */
export function Manual({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-5 rounded-xl border bg-white p-6 text-sm leading-7 text-slate-900">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** API snippets remain selectable and scroll horizontally on smaller screens. */
export function ApiCode({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-slate-100 p-4 text-xs leading-6">
      <code>{children}</code>
    </pre>
  );
}

/** Shared API address and authentication instructions for each resource manual. */
export function ApiHelp() {
  return (
    <p>
      {t("以下路径均以当前 Cluster 地址为根地址，请求头使用")}{" "}
      <code>Authorization: Bearer &lt;CLUSTER_SERVICE_API_KEY&gt;</code>。{t("参数和在线调试见")}{" "}
      <a
        href="/openapi"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-blue-700 underline underline-offset-4"
      >
        {t("API 文档")}
      </a>
      {t("，接口定义见")}{" "}
      <a
        href="/openapi/json"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-blue-700 underline underline-offset-4"
      >
        OpenAPI JSON
      </a>
      。
    </p>
  );
}

/** Scheduling rules shown alongside pool configuration. */
export function SchedulingHelp() {
  return (
    <section aria-label={t("调度方式介绍")} className="space-y-3 text-sm leading-7">
      <h3 className="text-base font-semibold">{t("调度方式")}</h3>
      <p>
        <strong>{t("数量模式：")}</strong>
        {t("按节点沙盒数量上限分配，优先选择占用比例低的节点，适合资源超卖。")}
      </p>
      <p>
        <strong>{t("资源模式：")}</strong>
        {t("逐节点检查剩余 CPU、内存、硬盘和 GPU，四项均满足才分配，租期到期自动销毁。")}
      </p>
    </section>
  );
}

/** Deployment prerequisites and the two node connection paths. */
export function ConnectionHelp({ mode }: { mode?: "direct" | "tunnel" }) {
  return (
    <section aria-label={t("节点连接介绍")} className="space-y-3 text-sm leading-7">
      {!mode && <h3 className="text-base font-semibold">{t("连接节点")}</h3>}
      {mode !== "tunnel" && (
        <p>
          <strong>direct：</strong>
          {t("直连，配置简单；Cluster 直接访问节点，节点需要开放可达的入站端口。")}
        </p>
      )}
      {mode !== "direct" && (
        <p>
          <strong>tunnel：</strong>
          {t("节点额外部署 frpc，主动连接 Cluster 侧的 frps，节点无需开放入站端口。")}
        </p>
      )}
      {!mode && (
        <p>
          {t("先在目标机器上启动 OpenSandbox Server 节点，再将节点连接到 Cluster。节点镜像：")}
          <code className="break-all rounded bg-slate-100 px-1 py-0.5">
            ghcr.io/huangpustar/fenixagent-opensandbox-server:v0.2.0
          </code>
          {t("。具体启动方式见")}{" "}
          <a
            className="font-medium text-blue-700 underline underline-offset-4"
            href="https://github.com/HuangPuStar/FenixAgent/tree/main/docker/opensandbox-server"
            target="_blank"
            rel="noreferrer"
          >
            {t("节点部署文档")}
          </a>
          。
        </p>
      )}
    </section>
  );
}

/** Pool creation, maintenance and API entry points. */
export function PoolManual() {
  return (
    <Manual title={t("池使用手册")}>
      <SchedulingHelp />
      <h3 className="text-base font-semibold">{t("1. 页面操作")}</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          {t(
            "点击「新建池」，填写唯一的池 ID、名称和调度模式。资源模式还需设置默认租期和最大租期，单位为秒，至少 60 秒。",
          )}
        </li>
        <li>
          {t(
            "通过「详情」「资源」查看配置和使用量，通过「编辑」修改配置。切换调度模式前，需要移空节点并释放所有非终态沙盒绑定。",
          )}
        </li>
        <li>
          {t(
            "删除池前，先清理池内沙盒记录和节点，再点击「删除」。暂时不再分配时，可将池设置为 disabled；数量模式还需将节点设为 draining 或 disabled。",
          )}
        </li>
      </ol>
      <h3 className="text-base font-semibold">{t("2. API 操作")}</h3>
      <ApiHelp />
      <ApiCode>{`POST   /api/v1/pools
GET    /api/v1/pools
GET    /api/v1/pools/{poolId}
PUT    /api/v1/pools/{poolId}
DELETE /api/v1/pools/{poolId}
GET    /api/v1/pools/{poolId}/resources`}</ApiCode>
      <details>
        <summary className="cursor-pointer font-medium">{t("创建资源模式池示例（JSON）")}</summary>
        <ApiCode>{`{
  "id": "gpu-pool",
  "name": "GPU Pool",
  "scheduling_mode": "resources",
  "default_lease_seconds": 3600,
  "max_lease_seconds": 86400
}`}</ApiCode>
      </details>
      <p>
        {t(
          "创建数量模式池时设置 scheduling_mode 为 count。PUT 只需提供要修改的字段；资源查询按节点返回，不能将多个节点的剩余资源合并分配。",
        )}
      </p>
    </Manual>
  );
}

/** Node deployment, registration and API operations. */
export function ServerManual() {
  return (
    <Manual title={t("节点使用手册")}>
      <ConnectionHelp />
      <h3 className="text-base font-semibold">{t("1. 页面操作")}</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          {t(
            "先创建池并部署节点，再点击「新建节点」，选择所属池，填写节点 ID、名称、工作目录和节点 API Key。节点 API Key 须与 OpenSandbox Server 配置一致。",
          )}
        </li>
        <li>
          {t(
            "direct 填写 Cluster 可访问的节点地址；tunnel 注册后点击「下载 frpc.toml」，将配置部署到目标节点的 frpc，等待连接恢复。",
          )}
        </li>
        <li>
          {t(
            "数量池填写沙盒数量上限；资源池填写 CPU 核数（支持小数）、内存 MB、硬盘 GB 和 GPU 数量。工作目录须与节点挂载路径及 allowed_host_paths 一致。",
          )}
        </li>
        <li>
          {t(
            "通过「健康检查」确认节点可用，通过「详情」「资源」查看信息。编辑时节点 API Key 留空会保留原值；有占用时不能迁池或缩容到已用量以下。",
          )}
        </li>
        <li>
          {t("维护前将节点设为 draining，停止新的分配；disabled 会同时拒绝代理访问。删除前先清理节点上的沙盒及记录。")}
        </li>
      </ol>
      <h3 className="text-base font-semibold">{t("2. API 操作")}</h3>
      <ApiHelp />
      <ApiCode>{`POST   /api/v1/servers
GET    /api/v1/servers?pool_id={poolId}
GET    /api/v1/servers/{serverId}
PUT    /api/v1/servers/{serverId}
DELETE /api/v1/servers/{serverId}
POST   /api/v1/servers/{serverId}/health-check
GET    /api/v1/servers/{serverId}/resources
GET    /api/v1/servers/{serverId}/tunnel/frpc.toml`}</ApiCode>
      <details>
        <summary className="cursor-pointer font-medium">{t("注册 direct 资源节点示例（JSON）")}</summary>
        <ApiCode>{`{
  "id": "gpu-node-1",
  "pool_id": "gpu-pool",
  "name": "GPU Node 1",
  "transport_mode": "direct",
  "base_url": "http://node.example.com:8090",
  "workspace_root": "/workspace",
  "api_key": "<NODE_API_KEY>",
  "cpu_capacity": 8,
  "memory_capacity_mb": 16384,
  "disk_capacity_gb": 100,
  "gpu_capacity": 1
}`}</ApiCode>
      </details>
      <p>
        {t(
          "数量池使用 max_sandboxes 配置数量上限。tunnel 节点设置 transport_mode 为 tunnel，省略 base_url，注册后下载并部署 frpc.toml。",
        )}
      </p>
      <h3 className="text-base font-semibold">{t("3. 使用 Skill 让 Agent 部署节点")}</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <SkillDownload name="deploy-opensandbox-node" />
        </li>
        <li>
          {t(
            "将压缩包解压到使用方 Agent 的技能目录，保留 deploy-opensandbox-node/SKILL.md 及同目录下的 assets、references。按 Agent 的方式重新加载技能；支持项目技能的 Agent 可安装到其工作项目的 .agents/skills/。",
          )}
        </li>
        <li>
          {t(
            "在 Agent 可读取的环境变量或安全配置中提供 CLUSTER_URL 和 CLUSTER_SERVICE_API_KEY，并授予目标机器的终端或 SSH 操作权限。告知池 ID、节点 ID、连接方式及可分配容量；节点 API Key 由 Agent 单独生成和配置。",
          )}
        </li>
        <li>{t("向 Agent 发送下面的指令并替换示例参数。Agent 会检查 Docker、部署节点、注册到池并验证健康状态。")}</li>
      </ol>
      <ApiCode>
        {t(`使用 deploy-opensandbox-node Skill，在 SSH 目标机器 node-1 上部署 OpenSandbox Server。
Cluster 地址和密钥从已配置的 CLUSTER_URL、CLUSTER_SERVICE_API_KEY 读取。
注册到 gpu-pool，节点 ID 为 gpu-node-1，使用 tunnel 连接。
可分配容量为 8 核 CPU、16384 MB 内存、100 GB 硬盘、1 个 GPU。
完成后告诉我节点健康状态、部署目录和停止命令。`)}
      </ApiCode>
      <p>{t("数量模式池将容量改为沙盒数量上限；direct 连接还需提供 Cluster 可访问的目标机器地址和入站端口。")}</p>
    </Manual>
  );
}
