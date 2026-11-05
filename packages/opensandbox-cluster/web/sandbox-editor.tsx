import { useState } from "react";
import { ClusterApiError, type ClusterClient } from "./api/client";
import type { Pool, Resources, SandboxInput } from "./api/types";
import { Editor, Field, Select, Textarea } from "./components";
import { t } from "./i18n";

/** Validate advanced JSON before reserving any capacity. */
function environment(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== "string")
  )
    throw new Error(t("环境变量须为字符串键值对象"));
  return parsed as Record<string, string>;
}
/** Structured create form keeps resource units identical in both scheduling modes. */
export function SandboxEditor({
  pools,
  client,
  close,
  saved,
}: {
  pools: Pool[];
  client: ClusterClient;
  close: () => void;
  saved: () => void;
}) {
  const [poolId, setPoolId] = useState(pools[0]?.id ?? "");
  const pool = pools.find((p) => p.id === poolId);
  const [id, setId] = useState<string>(() => crypto.randomUUID());
  const [image, setImage] = useState("");
  const [entrypoint, setEntrypoint] = useState('["sleep", "infinity"]');
  const [env, setEnv] = useState("{}");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("/workspace");
  const [resources, setResources] = useState<Resources>({ cpu: 1, memoryMb: 512, diskGb: 5, gpuCount: 0 });
  const [lease, setLease] = useState("");
  const [countAttempted, setCountAttempted] = useState(false);
  const labels: Record<keyof Resources, string> = {
    cpu: t("CPU（核）"),
    memoryMb: t("内存（MB）"),
    diskGb: t("硬盘（GB）"),
    gpuCount: t("GPU（数量）"),
  };
  return (
    <Editor
      title={t("新建沙盒")}
      description={t("选择池后由 Cluster 分配节点。创建结果未知时，请在列表中查看状态。")}
      close={close}
      save={async () => {
        if (countAttempted) throw new Error(t("此创建请求已发送，请关闭表单并在列表中检查，避免重复创建"));
        if (!pool) throw new Error(t("请选择池"));
        const command: unknown = JSON.parse(entrypoint);
        if (!Array.isArray(command) || command.some((value) => typeof value !== "string"))
          throw new Error(t("启动命令须为字符串数组"));
        const input: SandboxInput = {
          sandbox_id: id.trim(),
          resources: {
            ...resources,
            environment: environment(env),
            ...(source ? { volumes: [{ name: "workspace", source, target }] } : {}),
          },
          sandbox: { image: { uri: image.trim() }, entrypoint: command },
        };
        if (pool.schedulingMode === "resources" && lease) input.lease_seconds = Number(lease);
        if (pool.schedulingMode === "count") setCountAttempted(true);
        try {
          await client.createSandbox(poolId, pool.schedulingMode, input);
          saved();
        } catch (error) {
          if (error instanceof ClusterApiError && error.createRejected) setCountAttempted(false);
          saved();
          throw error;
        }
      }}
    >
      <Field label={t("所属池")}>
        <Select
          aria-label={t("所属池")}
          required
          value={poolId}
          onChange={(e) => {
            setPoolId(e.target.value);
            setLease("");
          }}
        >
          {pools.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name} · {p.schedulingMode}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("沙盒 ID")}
        value={id}
        onChange={(e) => setId(e.target.value)}
        disabled={countAttempted}
        required
      />
      <Field
        label={t("镜像")}
        value={image}
        onChange={(e) => setImage(e.target.value)}
        required
        placeholder="alpine:3.21"
      />
      <div className="grid grid-cols-2 gap-4">
        {(Object.keys(resources) as (keyof Resources)[]).map((k) => (
          <Field
            key={k}
            label={labels[k]}
            type="number"
            min={k === "gpuCount" ? 0 : 0.001}
            step={k === "gpuCount" ? 1 : "any"}
            value={resources[k]}
            onChange={(e) => setResources({ ...resources, [k]: e.target.valueAsNumber })}
            required
          />
        ))}
      </div>
      {pool?.schedulingMode === "resources" && (
        <Field
          label={t("租期（秒，默认 {{seconds}}）", { seconds: pool.defaultLeaseSeconds ?? 60 })}
          type="number"
          min={60}
          max={pool.maxLeaseSeconds ?? undefined}
          step={1}
          value={lease}
          onChange={(e) => setLease(e.target.value)}
        />
      )}
      <Field label={t("启动命令（JSON 数组）")}>
        <Textarea
          aria-label={t("启动命令")}
          value={entrypoint}
          onChange={(e) => setEntrypoint(e.target.value)}
          required
          className="font-mono text-xs"
        />
      </Field>
      <Field label={t("环境变量（JSON 对象）")}>
        <Textarea
          aria-label={t("环境变量")}
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          required
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field
          label={t("工作目录相对路径（可选）")}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="user-123/ws"
        />
        <Field
          label={t("容器挂载路径")}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required={!!source}
        />
      </div>
    </Editor>
  );
}
