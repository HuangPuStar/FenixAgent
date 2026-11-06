import { useState } from "react";
import type { ClusterClient } from "./api/client";
import type { Pool, Server } from "./api/types";
import { Editor, Field, Select } from "./components";
import { ConnectionHelp } from "./help";
import { t } from "./i18n";

/** Pool editor validates scheduling mode and lease values using existing API rules. */
export function PoolEditor({
  item,
  client,
  close,
  saved,
}: {
  item?: Pool;
  client: ClusterClient;
  close: () => void;
  saved: () => void;
}) {
  const [id, setId] = useState(item?.id ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [mode, setMode] = useState(item?.schedulingMode ?? "count");
  const [status, setStatus] = useState(item?.status ?? "active");
  const [lease, setLease] = useState(item?.defaultLeaseSeconds ?? 3600);
  const [maximum, setMaximum] = useState(item?.maxLeaseSeconds ?? 86400);
  return (
    <Editor
      title={item ? t("编辑池") : t("新建池")}
      close={close}
      save={async () => {
        if (mode === "resources" && maximum < lease) throw new Error(t("最大租期不能小于默认租期"));
        await client.request(`/api/v1/pools${item ? `/${encodeURIComponent(item.id)}` : ""}`, {
          method: item ? "PUT" : "POST",
          body: {
            ...(!item ? { id: id.trim() } : {}),
            name: name.trim(),
            status,
            scheduling_mode: mode,
            ...(mode === "resources" ? { default_lease_seconds: lease, max_lease_seconds: maximum } : {}),
          },
        });
        saved();
      }}
    >
      <Field
        label={t("池 ID")}
        value={id}
        onChange={(e) => setId(e.target.value)}
        disabled={!!item}
        required
        pattern={".*\\S.*"}
      />
      <Field label={t("名称")} value={name} onChange={(e) => setName(e.target.value)} required pattern={".*\\S.*"} />
      <Field label={t("调度模式")}>
        <Select
          aria-label={t("调度模式")}
          value={mode}
          onChange={(e) => setMode(e.target.value as Pool["schedulingMode"])}
        >
          <option value="count">{t("数量模式")}</option>
          <option value="resources">{t("资源模式")}</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {mode === "count"
            ? t("按节点沙盒数量上限分配，优先选择占用比例低的节点，适合资源超卖。")
            : t("逐节点检查剩余 CPU、内存、硬盘和 GPU，四项均满足才分配，租期到期自动销毁。")}
        </p>
      </Field>
      <Field label={t("状态")}>
        <Select aria-label={t("状态")} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </Select>
      </Field>
      {mode === "resources" && (
        <div className="grid grid-cols-2 gap-4">
          <Field
            label={t("默认租期（秒）")}
            type="number"
            min={60}
            step={1}
            required
            value={lease}
            onChange={(e) => setLease(e.target.valueAsNumber)}
          />
          <Field
            label={t("最大租期（秒）")}
            type="number"
            min={lease}
            step={1}
            required
            value={maximum}
            onChange={(e) => setMaximum(e.target.valueAsNumber)}
          />
        </div>
      )}
    </Editor>
  );
}

/** Node editor keeps stored API keys hidden and omits an unchanged secret. */
export function ServerEditor({
  item,
  pools,
  client,
  close,
  saved,
}: {
  item?: Server;
  pools: Pool[];
  client: ClusterClient;
  close: () => void;
  saved: () => void;
}) {
  const [id, setId] = useState(item?.id ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [poolId, setPoolId] = useState(item?.poolId ?? pools[0]?.id ?? "");
  const pool = pools.find((p) => p.id === poolId);
  const [transport, setTransport] = useState(item?.transportMode ?? "direct");
  const [url, setUrl] = useState(item?.baseUrl ?? "");
  const [root, setRoot] = useState(item?.workspaceRoot ?? "/workspace");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState(item?.status ?? "active");
  const [max, setMax] = useState(item?.maxSandboxes ?? 10);
  const [capacity, setCapacity] = useState({
    cpu_capacity: item?.cpuCapacity ?? 4,
    memory_capacity_mb: item?.memoryCapacityMb ?? 8192,
    disk_capacity_gb: item?.diskCapacityGb ?? 100,
    gpu_capacity: item?.gpuCapacity ?? 0,
  });
  const labels = {
    cpu_capacity: t("CPU（核）"),
    memory_capacity_mb: t("内存（MB）"),
    disk_capacity_gb: t("硬盘（GB）"),
    gpu_capacity: t("GPU（数量）"),
  };
  return (
    <Editor
      title={item ? t("编辑节点") : t("新建节点")}
      close={close}
      save={async () => {
        await client.request(`/api/v1/servers${item ? `/${encodeURIComponent(item.id)}` : ""}`, {
          method: item ? "PUT" : "POST",
          body: {
            ...(!item ? { id: id.trim(), transport_mode: transport } : {}),
            pool_id: poolId,
            name: name.trim(),
            ...(transport === "direct" ? { base_url: url.trim() } : {}),
            workspace_root: root.trim(),
            ...(key ? { api_key: key } : {}),
            status,
            ...(pool?.schedulingMode === "resources" ? capacity : { max_sandboxes: max }),
          },
        });
        saved();
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label={t("节点 ID")} value={id} onChange={(e) => setId(e.target.value)} disabled={!!item} required />
        <Field label={t("名称")} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <Field label={t("所属池")}>
        <Select aria-label={t("所属池")} value={poolId} required onChange={(e) => setPoolId(e.target.value)}>
          {pools.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("连接方式")}>
        <Select
          aria-label={t("连接方式")}
          value={transport}
          disabled={!!item}
          onChange={(e) => setTransport(e.target.value as Server["transportMode"])}
        >
          <option value="direct">direct</option>
          <option value="tunnel">tunnel</option>
        </Select>
      </Field>
      <ConnectionHelp mode={transport} />
      {transport === "direct" && (
        <Field
          label={t("节点地址")}
          type="url"
          placeholder="http://node:8090"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      )}
      <Field label={t("工作目录")} value={root} onChange={(e) => setRoot(e.target.value)} required />
      <Field
        label={item ? t("节点 API Key（留空保留）") : t("节点 API Key")}
        type="password"
        autoComplete="new-password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        required={!item}
      />
      <Field label={t("状态")}>
        <Select aria-label={t("状态")} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["active", "draining", "disabled"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </Select>
      </Field>
      {pool?.schedulingMode === "resources" ? (
        <div className="grid grid-cols-2 gap-4">
          {(Object.keys(capacity) as (keyof typeof capacity)[]).map((k) => (
            <Field
              key={k}
              label={labels[k]}
              type="number"
              min={k === "gpu_capacity" ? 0 : 0.001}
              step={k === "gpu_capacity" ? 1 : "any"}
              required
              value={capacity[k]}
              onChange={(e) => setCapacity({ ...capacity, [k]: e.target.valueAsNumber })}
            />
          ))}
        </div>
      ) : (
        <Field
          label={t("沙盒数量上限")}
          type="number"
          min={item ? 0 : 1}
          step={1}
          required
          value={max}
          onChange={(e) => setMax(e.target.valueAsNumber)}
        />
      )}
    </Editor>
  );
}
