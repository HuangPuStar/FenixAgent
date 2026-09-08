import { Check, CircleX, KeyRound, Plus, Trash2, WandSparkles } from "lucide-react";
import { useState } from "react";
import { Modal, Status } from "../../components/ui";
import {
  contextToTokens,
  DISCOVERED_MODELS,
  type ModelDialogState,
  type SandboxModel,
  type SandboxProvider,
} from "./model-sandbox-data";

export interface ProviderDraft {
  id: string;
  name: string;
  protocol: SandboxProvider["protocol"];
  endpoint: string;
}

export interface ModelDraft {
  id: string;
  name: string;
  context: string;
  thinkingBudget: string;
  inputCost: string;
  outputCost: string;
  thinking: boolean;
}

interface ModelDialogsProps {
  dialog: ModelDialogState;
  onClose: () => void;
  onSaveProvider: (draft: ProviderDraft, selectedModels: string[], provider?: SandboxProvider) => void;
  onSaveModel: (draft: ModelDraft, provider: SandboxProvider, model?: SandboxModel) => void;
  onAddDiscovered: (provider: SandboxProvider, selectedModels: string[]) => void;
  onConfirmResource: (dialog: Extract<ModelDialogState, { kind: "delete-provider" | "delete-model" }>) => void;
}

function toggleSelection(current: Set<string>, item: string): Set<string> {
  const next = new Set(current);
  next.has(item) ? next.delete(item) : next.add(item);
  return next;
}

export function ModelDialogs({
  dialog,
  onClose,
  onSaveProvider,
  onSaveModel,
  onAddDiscovered,
  onConfirmResource,
}: ModelDialogsProps) {
  const provider = "provider" in dialog ? dialog.provider : undefined;
  const model = dialog.kind === "model" ? dialog.model : undefined;
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    id: provider?.id ?? "",
    name: provider?.name ?? "",
    protocol: provider?.protocol ?? "OpenAI 兼容",
    endpoint: provider?.endpoint ?? "",
  });
  const [modelDraft, setModelDraft] = useState({
    id: model?.id ?? "",
    name: model?.name ?? "",
    context: model ? String(contextToTokens(model.context)) : "",
    thinkingBudget: model?.thinking ? "32000" : "",
    inputCost: model ? String(model.cost.input) : "",
    outputCost: model ? String(model.cost.output) : "",
  });
  const [thinking, setThinking] = useState(Boolean(model?.thinking));
  const [selectedDiscovered, setSelectedDiscovered] = useState(new Set<string>());
  const [probeState, setProbeState] = useState<"idle" | "success" | "error">("idle");

  if (dialog.kind === "provider") {
    return (
      <Modal
        title={dialog.provider ? "编辑服务商" : "新建服务商"}
        onClose={onClose}
        onConfirm={() => onSaveProvider(providerDraft, [...selectedDiscovered], dialog.provider)}
      >
        <div className="model-form-grid">
          <label>
            ID（创建后不可修改）
            <input
              value={providerDraft.id}
              onChange={(event) => setProviderDraft((current) => ({ ...current, id: event.target.value }))}
              placeholder="例如 openai-production"
              disabled={Boolean(dialog.provider)}
            />
          </label>
          <label>
            显示名称
            <input
              value={providerDraft.name}
              onChange={(event) => setProviderDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="例如 OpenAI Production"
            />
          </label>
          <label>
            协议
            <select
              value={providerDraft.protocol}
              onChange={(event) =>
                setProviderDraft((current) => ({
                  ...current,
                  protocol: event.target.value as SandboxProvider["protocol"],
                }))
              }
            >
              <option>OpenAI 兼容</option>
              <option>Anthropic</option>
            </select>
          </label>
          <label>
            API Key
            <input
              type="password"
              placeholder={dialog.provider ? `已配置 ${dialog.provider.keyHint}` : "输入 API Key 或环境密钥引用"}
            />
          </label>
          <label className="is-wide">
            Base URL
            <input
              value={providerDraft.endpoint}
              onChange={(event) => setProviderDraft((current) => ({ ...current, endpoint: event.target.value }))}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <p className="is-wide">
            <KeyRound />
            密钥仅用于本次连接探测，保存后只显示掩码；生产环境由 RCS_SECRET_* 引用管理。
          </p>
          <section className="provider-probe is-wide">
            <header>
              <div>
                <strong>可用模型</strong>
                <span>使用当前表单内容临时探测，不会提前保存凭证。</span>
              </div>
              <button
                type="button"
                onClick={() => setProbeState(providerDraft.endpoint.includes("invalid") ? "error" : "success")}
              >
                {probeState === "idle" ? "连接并获取模型" : "重新获取"}
              </button>
            </header>
            {probeState === "success" && (
              <div>
                {DISCOVERED_MODELS.slice(0, 3).map((item) => (
                  <button
                    type="button"
                    aria-pressed={selectedDiscovered.has(item)}
                    className={selectedDiscovered.has(item) ? "is-selected" : ""}
                    key={item}
                    onClick={() => setSelectedDiscovered((current) => toggleSelection(current, item))}
                  >
                    <span>{selectedDiscovered.has(item) ? <Check /> : <Plus />}</span>
                    <code>{item}</code>
                  </button>
                ))}
              </div>
            )}
            {probeState === "error" && (
              <p role="alert">
                <CircleX />
                连接失败。检查 Base URL 与密钥后重试；若服务商不开放模型列表，可保存后手动添加模型。
              </p>
            )}
          </section>
        </div>
      </Modal>
    );
  }

  if (dialog.kind === "model") {
    return (
      <Modal
        title={dialog.model ? `编辑模型 · ${dialog.model.id}` : `添加模型 · ${dialog.provider.name}`}
        onClose={onClose}
        onConfirm={() => onSaveModel({ ...modelDraft, thinking }, dialog.provider, dialog.model)}
      >
        <div className="model-form-grid">
          <label>
            模型 ID
            <input
              value={modelDraft.id}
              onChange={(event) => setModelDraft((current) => ({ ...current, id: event.target.value }))}
              placeholder="例如 gpt-5.2"
              disabled={Boolean(dialog.model)}
            />
          </label>
          <label>
            显示名称
            <input
              value={modelDraft.name}
              onChange={(event) => setModelDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="用于界面显示"
            />
          </label>
          <label>
            上下文限制
            <input
              type="number"
              value={modelDraft.context}
              onChange={(event) => setModelDraft((current) => ({ ...current, context: event.target.value }))}
              placeholder="tokens"
            />
          </label>
          <label>
            思考预算
            <input
              type="number"
              value={modelDraft.thinkingBudget}
              onChange={(event) => setModelDraft((current) => ({ ...current, thinkingBudget: event.target.value }))}
              placeholder="tokens"
              disabled={!thinking}
            />
          </label>
          <label className="thinking-toggle is-wide">
            <button
              type="button"
              role="switch"
              aria-label="启用思考模式"
              aria-checked={thinking}
              className={thinking ? "is-on" : ""}
              onClick={() => setThinking((value) => !value)}
            >
              <i />
            </button>
            <span>
              启用思考模式<small>可为支持推理的模型设置 token 预算。</small>
            </span>
          </label>
          <label>
            输入费用
            <input
              type="number"
              step="0.01"
              value={modelDraft.inputCost}
              onChange={(event) => setModelDraft((current) => ({ ...current, inputCost: event.target.value }))}
              placeholder="$/百万 tokens"
            />
          </label>
          <label>
            输出费用
            <input
              type="number"
              step="0.01"
              value={modelDraft.outputCost}
              onChange={(event) => setModelDraft((current) => ({ ...current, outputCost: event.target.value }))}
              placeholder="$/百万 tokens"
            />
          </label>
        </div>
      </Modal>
    );
  }

  if (dialog.kind === "discover") {
    return (
      <Modal
        title={`发现模型 · ${dialog.provider.name}`}
        onClose={onClose}
        confirmText={`添加所选 ${selectedDiscovered.size}`}
        onConfirm={() => onAddDiscovered(dialog.provider, [...selectedDiscovered])}
      >
        <div className="discover-summary">
          <Status kind="success">连接成功</Status>
          <span>从服务商接口发现 {DISCOVERED_MODELS.length} 个未配置模型。</span>
        </div>
        <div className="discovered-models">
          {DISCOVERED_MODELS.map((item) => (
            <button
              type="button"
              aria-pressed={selectedDiscovered.has(item)}
              className={selectedDiscovered.has(item) ? "is-selected" : ""}
              key={item}
              onClick={() => setSelectedDiscovered((current) => toggleSelection(current, item))}
            >
              <WandSparkles />
              <code>{item}</code>
              <span>{selectedDiscovered.has(item) ? <Check /> : <Plus />}</span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="确认删除" confirmText="删除" onClose={onClose} onConfirm={() => onConfirmResource(dialog)}>
      <div className="resource-confirm is-danger">
        <Trash2 />
        <div>
          <strong>{dialog.kind === "delete-model" ? dialog.model.name : dialog.provider.name}</strong>
          <p>删除资源链不可撤销；存在 Agent 引用时，真实服务会拒绝删除。</p>
        </div>
      </div>
    </Modal>
  );
}
