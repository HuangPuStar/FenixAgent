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

const AVAILABLE_TOOLS = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "Agent",
    "TaskCreate",
    "TaskUpdate",
];

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
    const [formTools, setFormTools] = useState<string[]>([]);
    const [formPrompt, setFormPrompt] = useState("");
    const [formSaving, setFormSaving] = useState(false);

    const loadAgents = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiListAgents();
            setAgents(data.agents);
            setDefaultAgent(data.default_agent);
        } catch (e) {
            toast.error(
                "加载代理列表失败: " +
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
        setFormTools([...AVAILABLE_TOOLS]);
        setFormPrompt("");
        setDialogOpen(true);
    };

    const handleOpenEdit = async (agent: AgentInfo) => {
        setEditingAgent(agent);
        setFormName(agent.name);
        setFormModel(agent.model || "");
        setFormMode(agent.mode || "primary");
        setFormPrompt("");
        try {
            const detail = await apiGetAgent(agent.name);
            setFormSteps(String(detail.steps ?? 50));
            setFormTools(detail.tools ? Object.keys(detail.tools as Record<string, unknown>) : []);
            setFormPrompt(detail.prompt || "");
        } catch {
            setFormSteps("50");
            setFormTools([]);
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
        setFormSaving(true);
        try {
            const data: Record<string, unknown> = {
                model: formModel || undefined,
                mode: formMode,
                steps: parseInt(formSteps),
                tools: Object.fromEntries(formTools.map((t) => [t, true])),
                prompt: formPrompt || undefined,
            };
            if (editingAgent) {
                await apiSetAgent(name, data);
                toast.success("代理已更新");
            } else {
                await apiCreateAgent(name, data);
                toast.success("代理已创建");
            }
            setDialogOpen(false);
            loadAgents();
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
            toast.success(`已将 "${name}" 设为默认代理`);
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
            toast.success("代理已删除");
            setConfirmOpen(false);
            loadAgents();
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
            toast.success(`已删除 ${customAgents.length} 个代理`);
            setBatchConfirmOpen(false);
            setSelected([]);
            loadAgents();
        } catch (e) {
            toast.error(
                "批量删除失败: " +
                    (e instanceof Error ? e.message : "未知错误"),
            );
        }
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                加载中...
            </div>
        );
    }

    return (
        <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">代理管理</h2>
                <Button onClick={handleOpenCreate}>新建代理</Button>
            </div>
            <DataTable<AgentInfo>
                columns={columns}
                data={agents}
                searchable
                searchPlaceholder="搜索代理..."
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
                title={editingAgent ? "编辑代理" : "新建代理"}
                onSubmit={handleSave}
                loading={formSaving}>
                <div className="space-y-4 max-h-[60vh] overflow-y-auto">
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
                        <Select value={formModel} onValueChange={setFormModel}>
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
                    <div>
                        <Label>模式</Label>
                        <Select value={formMode} onValueChange={setFormMode}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="primary">primary</SelectItem>
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
                            onChange={(e) => setFormSteps(e.target.value)}
                            min={1}
                            max={200}
                        />
                    </div>
                    <div>
                        <Label>工具</Label>
                        <div className="flex flex-wrap gap-2 mt-1">
                            {AVAILABLE_TOOLS.map((tool) => (
                                <label
                                    key={tool}
                                    className="flex items-center gap-1 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={formTools.includes(tool)}
                                        onChange={(e) => {
                                            setFormTools((prev) =>
                                                e.target.checked
                                                    ? [...prev, tool]
                                                    : prev.filter(
                                                          (t) => t !== tool,
                                                      ),
                                            );
                                        }}
                                    />
                                    {tool}
                                </label>
                            ))}
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
                </div>
            </FormDialog>
            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="确认删除"
                description={`确定要删除代理 "${deleteTarget}" 吗？`}
                variant="destructive"
                onConfirm={confirmDelete}
            />
            <ConfirmDialog
                open={batchConfirmOpen}
                onOpenChange={setBatchConfirmOpen}
                title="批量删除确认"
                description={`确定要删除选中的 ${selected.filter((a) => !a.builtIn).length} 个自定义代理吗？`}
                variant="destructive"
                onConfirm={confirmBatchDelete}
            />
        </div>
    );
}
