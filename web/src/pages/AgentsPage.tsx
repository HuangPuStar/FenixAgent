import { useState, useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
    apiListAgents,
    apiGetAgent,
    apiCreateAgent,
    apiSetAgent,
    apiDeleteAgent,
    apiSetDefaultAgent,
    apiGetModels,
} from "../api/client";
import type { AgentInfo } from "../types/config";
import { PermissionTab } from "../components/PermissionTab";
import { dispatchConfigChange } from "../lib/config-events";

export function isValidAgentNameInput(name: string): boolean {
    return (
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) &&
        name.length >= 1 &&
        name.length <= 64
    );
}

export function isValidStepsInput(steps: string): boolean {
    const n = parseInt(steps);
    return !isNaN(n) && n >= 1 && n <= 200;
}

export function AgentsPage() {
    const [agents, setAgents] = useState<AgentInfo[]>([]);
    const [defaultAgent, setDefaultAgent] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingAgent, setEditingAgent] = useState<AgentInfo | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const [selected, setSelected] = useState<AgentInfo[]>([]);
    const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
    const [modelOptions, setModelOptions] = useState<string[]>([]);
    const [formName, setFormName] = useState("");
    const [formModel, setFormModel] = useState("");
    const [formMode, setFormMode] = useState("primary");
    const [formSteps, setFormSteps] = useState("50");
    const [formPrompt, setFormPrompt] = useState("");
    const [formSaving, setFormSaving] = useState(false);
    const [formDescription, setFormDescription] = useState("");
    const [formVariant, setFormVariant] = useState("");
    const [formTemperature, setFormTemperature] = useState("");
    const [formTopP, setFormTopP] = useState("");
    const [formColor, setFormColor] = useState("");
    const [formHidden, setFormHidden] = useState(false);
    const [formDisable, setFormDisable] = useState(false);
    const [formPermission, setFormPermission] = useState<Record<
        string,
        unknown
    > | null>(null);
    const [activeTab, setActiveTab] = useState<"basic" | "permission">("basic");

    const loadAgents = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiListAgents();
            setAgents(data.agents);
            setDefaultAgent(data.default_agent);
        } catch (e) {
            toast.error(
                "加载Agent列表失败: " +
                    (e instanceof Error ? e.message : "未知错误"),
            );
        } finally {
            setLoading(false);
        }
    }, []);

    const loadModelOptions = useCallback(async () => {
        try {
            const data = await apiGetModels();
            setModelOptions(data.available.map((m) => m.fullId));
        } catch {
            /* silent */
        }
    }, []);

    useEffect(() => {
        loadAgents();
        loadModelOptions();
    }, [loadAgents, loadModelOptions]);

    const columns: Column<AgentInfo>[] = [
        { key: "name", header: "名称", sortable: true, filterable: true },
        {
            key: "builtIn",
            header: "类型",
            filterable: true,
            render: (row) => (
                <StatusBadge status={row.builtIn ? "builtIn" : "custom"} />
            ),
        },
        { key: "model", header: "模型", sortable: true },
        {
            key: "mode",
            header: "模式",
            filterable: true,
            render: (row) =>
                row.mode ? <StatusBadge status={row.mode} /> : "—",
        },
        {
            key: "default",
            header: "默认",
            render: (row) => (row.name === defaultAgent ? "★" : ""),
        },
    ];

    const handleOpenCreate = () => {
        setEditingAgent(null);
        setFormName("");
        setFormModel(modelOptions[0] || "");
        setFormMode("primary");
        setFormSteps("50");
        setFormPrompt("");
        setFormDescription("");
        setFormVariant("");
        setFormTemperature("");
        setFormTopP("");
        setFormColor("");
        setFormHidden(false);
        setFormDisable(false);
        setFormPermission(null);
        setDialogOpen(true);
    };

    const handleOpenEdit = async (agent: AgentInfo) => {
        setEditingAgent(agent);
        setFormName(agent.name);
        setFormModel(agent.model || "");
        setFormMode(agent.mode || "primary");
        setFormPrompt("");
        setFormDescription("");
        setFormVariant("");
        setFormTemperature("");
        setFormTopP("");
        setFormColor("");
        setFormHidden(false);
        setFormDisable(false);
        setFormPermission(null);
        try {
            const detail = await apiGetAgent(agent.name);
            setFormSteps(String(detail.steps ?? 50));
            setFormPrompt(detail.prompt || "");
            setFormDescription(detail.description || "");
            setFormVariant(detail.variant || "");
            setFormTemperature(
                detail.temperature !== null && detail.temperature !== undefined
                    ? String(detail.temperature)
                    : "",
            );
            setFormTopP(
                detail.top_p !== null && detail.top_p !== undefined
                    ? String(detail.top_p)
                    : "",
            );
            setFormColor(detail.color || "");
            setFormHidden(detail.hidden ?? false);
            setFormDisable(detail.disable ?? false);
            setFormPermission(
                detail.permission
                    ? typeof detail.permission === "string"
                        ? (detail.permission as unknown as Record<
                              string,
                              unknown
                          >)
                        : (detail.permission as Record<string, unknown>)
                    : null,
            );
        } catch {
            setFormSteps("50");
        }
        setDialogOpen(true);
    };

    const handleSave = async () => {
        const name = formName.trim();
        if (!isValidAgentNameInput(name)) {
            toast.error("名称只能包含小写字母、数字和单连字符，长度 1-64");
            return;
        }
        if (!isValidStepsInput(formSteps)) {
            toast.error("最大轮数须在 1-200 之间");
            return;
        }
        if (formTemperature !== "") {
            const t = parseFloat(formTemperature);
            if (isNaN(t) || t < 0 || t > 2) {
                toast.error("温度须在 0-2 之间");
                return;
            }
        }
        if (formTopP !== "") {
            const p = parseFloat(formTopP);
            if (isNaN(p) || p < 0 || p > 1) {
                toast.error("Top P 须在 0-1 之间");
                return;
            }
        }
        setFormSaving(true);
        try {
            const data: Record<string, unknown> = {
                model: formModel || undefined,
                mode: formMode,
                steps: parseInt(formSteps),
                prompt: formPrompt || undefined,
                description: formDescription || undefined,
                variant: formVariant || undefined,
                temperature:
                    formTemperature !== ""
                        ? parseFloat(formTemperature)
                        : undefined,
                top_p: formTopP !== "" ? parseFloat(formTopP) : undefined,
                color: formColor || undefined,
                hidden: formHidden,
                disable: formDisable,
                permission: formPermission,
            };
            if (editingAgent) {
                await apiSetAgent(name, data);
                toast.success("Agent已更新");
            } else {
                await apiCreateAgent(name, data);
                toast.success("Agent已创建");
            }
            setDialogOpen(false);
            loadAgents();
            dispatchConfigChange("agents");
        } catch (e) {
            toast.error(
                "保存失败: " + (e instanceof Error ? e.message : "未知错误"),
            );
        } finally {
            setFormSaving(false);
        }
    };

    const handleSetDefault = async (name: string) => {
        try {
            await apiSetDefaultAgent(name);
            setDefaultAgent(name);
            toast.success(`已将 "${name}" 设为默认Agent`);
        } catch (e) {
            toast.error(
                "设置失败: " + (e instanceof Error ? e.message : "未知错误"),
            );
        }
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        try {
            await apiDeleteAgent(deleteTarget);
            toast.success("Agent已删除");
            setConfirmOpen(false);
            loadAgents();
            dispatchConfigChange("agents");
        } catch (e) {
            toast.error(
                "删除失败: " + (e instanceof Error ? e.message : "未知错误"),
            );
        }
    };

    const confirmBatchDelete = async () => {
        const customAgents = selected.filter((a) => !a.builtIn);
        try {
            await Promise.all(customAgents.map((a) => apiDeleteAgent(a.name)));
            toast.success(`已删除 ${customAgents.length} 个Agent`);
            setBatchConfirmOpen(false);
            setSelected([]);
            loadAgents();
            dispatchConfigChange("agents");
        } catch (e) {
            toast.error(
                "批量删除失败: " +
                    (e instanceof Error ? e.message : "未知错误"),
            );
        }
    };

    if (loading) {
        return (
            <div className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                    <Skeleton className="h-7 w-32" />
                    <Skeleton className="h-9 w-24" />
                </div>
                <div className="rounded-md border">
                    <Skeleton className="h-10 w-full rounded-t-md" />
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton
                            key={i}
                            className="h-12 w-full rounded-none border-t"
                        />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-text-bright">Agent管理</h2>
                <Button onClick={handleOpenCreate}>新建Agent</Button>
            </div>
            <DataTable<AgentInfo>
                columns={columns}
                data={agents}
                searchable
                searchPlaceholder="搜索Agent..."
                selectable
                onSelectionChange={setSelected}
                actions={(row) => (
                    <div className="flex gap-2">
                        {row.name !== defaultAgent && (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleSetDefault(row.name)}>
                                设为默认
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenEdit(row)}>
                            编辑
                        </Button>
                        {!row.builtIn && (
                            <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => {
                                    setDeleteTarget(row.name);
                                    setConfirmOpen(true);
                                }}>
                                删除
                            </Button>
                        )}
                    </div>
                )}
            />
            {selected.length > 0 && (
                <BatchActionBar
                    selectedCount={selected.length}
                    onClear={() => setSelected([])}
                    actions={[
                        {
                            label: "批量删除",
                            variant: "destructive",
                            onClick: () => setBatchConfirmOpen(true),
                        },
                    ]}
                />
            )}
            <FormDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={editingAgent ? "编辑Agent" : "新建Agent"}
                onSubmit={handleSave}
                loading={formSaving}>
                <div className="flex gap-1 rounded-lg bg-surface-2 p-1 mb-4">
                    <button
                        type="button"
                        className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === "basic" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
                        onClick={() => setActiveTab("basic")}>
                        基础配置
                    </button>
                    <button
                        type="button"
                        className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === "permission" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
                        onClick={() => setActiveTab("permission")}>
                        权限配置
                    </button>
                </div>
                {activeTab === "basic" && (
                    <div className="space-y-4 max-h-[55vh] overflow-y-auto">
                        <div>
                            <Label>名称</Label>
                            <Input
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                disabled={!!editingAgent}
                                placeholder="例如 my-agent"
                            />
                        </div>
                        <div>
                            <Label>模型</Label>
                            <Select
                                value={formModel}
                                onValueChange={setFormModel}>
                                <SelectTrigger>
                                    <SelectValue placeholder="选择模型" />
                                </SelectTrigger>
                                <SelectContent>
                                    {modelOptions.map((m) => (
                                        <SelectItem key={m} value={m}>
                                            {m}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <Label>模式</Label>
                                <Select
                                    value={formMode}
                                    onValueChange={setFormMode}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="primary">
                                            primary
                                        </SelectItem>
                                        <SelectItem value="subagent">
                                            subagent
                                        </SelectItem>
                                        <SelectItem value="all">all</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div>
                                <Label>步数 (1-200)</Label>
                                <Input
                                    type="number"
                                    value={formSteps}
                                    onChange={(e) =>
                                        setFormSteps(e.target.value)
                                    }
                                    min={1}
                                    max={200}
                                />
                            </div>
                        </div>
                        <div>
                            <Label>提示词 (Prompt)</Label>
                            <Textarea
                                value={formPrompt}
                                onChange={(e) => setFormPrompt(e.target.value)}
                                rows={4}
                                placeholder="可选，自定义 Agent 提示词"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <Label>描述</Label>
                                <Input
                                    value={formDescription}
                                    onChange={(e) =>
                                        setFormDescription(e.target.value)
                                    }
                                    placeholder="可选，Agent 的简短描述"
                                />
                            </div>
                            <div>
                                <Label>Variant</Label>
                                <Input
                                    value={formVariant}
                                    onChange={(e) =>
                                        setFormVariant(e.target.value)
                                    }
                                    placeholder="可选，例如 thinking"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <Label>温度 (0-2)</Label>
                                <Input
                                    type="number"
                                    value={formTemperature}
                                    onChange={(e) =>
                                        setFormTemperature(e.target.value)
                                    }
                                    min={0}
                                    max={2}
                                    step={0.1}
                                    placeholder="可选"
                                />
                            </div>
                            <div>
                                <Label>Top P (0-1)</Label>
                                <Input
                                    type="number"
                                    value={formTopP}
                                    onChange={(e) =>
                                        setFormTopP(e.target.value)
                                    }
                                    min={0}
                                    max={1}
                                    step={0.1}
                                    placeholder="可选"
                                />
                            </div>
                        </div>
                        <div>
                            <Label>颜色</Label>
                            <div className="flex gap-2">
                                <Input
                                    type="color"
                                    value={formColor || "#000000"}
                                    onChange={(e) =>
                                        setFormColor(e.target.value)
                                    }
                                    className="w-12 h-9 p-1 cursor-pointer"
                                />
                                <Input
                                    value={formColor}
                                    onChange={(e) =>
                                        setFormColor(e.target.value)
                                    }
                                    placeholder="hex (#RRGGBB) 或预设色名"
                                    className="flex-1"
                                />
                            </div>
                        </div>
                        <div className="flex items-center gap-6">
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={formHidden}
                                    onChange={(e) =>
                                        setFormHidden(e.target.checked)
                                    }
                                />
                                隐藏
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={formDisable}
                                    onChange={(e) =>
                                        setFormDisable(e.target.checked)
                                    }
                                />
                                禁用
                            </label>
                        </div>
                    </div>
                )}
                {activeTab === "permission" && (
                    <div className="max-h-[55vh] overflow-y-auto">
                        <PermissionTab
                            key={editingAgent?.name ?? "__new__"}
                            agentName={formName}
                            permission={formPermission}
                            onPermissionChange={setFormPermission}
                        />
                    </div>
                )}
            </FormDialog>
            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="确认删除"
                description={`确定要删除Agent "${deleteTarget}" 吗？`}
                variant="destructive"
                onConfirm={confirmDelete}
            />
            <ConfirmDialog
                open={batchConfirmOpen}
                onOpenChange={setBatchConfirmOpen}
                title="批量删除确认"
                description={`确定要删除选中的 ${selected.filter((a) => !a.builtIn).length} 个自定义Agent吗？`}
                variant="destructive"
                onConfirm={confirmBatchDelete}
            />
        </div>
    );
}
