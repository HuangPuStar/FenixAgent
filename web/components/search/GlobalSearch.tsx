import { useNavigate } from "@tanstack/react-router";
import { Bot, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentApi } from "@/src/api/agents";
import { envApi } from "@/src/api/environments";
import { NS } from "@/src/i18n";
import type { AgentInfo } from "@/src/types/config";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";

interface GlobalSearchProps {
  /** 外部控制弹窗开关（可选，不传则使用内部 state） */
  open?: boolean;
  /** 外部控制弹窗开关回调 */
  onOpenChange?: (open: boolean) => void;
}

/**
 * 全局 Agent 搜索弹窗。
 * 通过 Ctrl+K / Cmd+K 快捷键或搜索按钮触发，按名称/ID/描述模糊搜索 Agent，
 * 选中后自动查找或创建运行环境并跳转到聊天页面。
 */
export function GlobalSearch({ open: externalOpen, onOpenChange: externalOnOpenChange }: GlobalSearchProps = {}) {
  const { t } = useTranslation(NS.COMPONENTS);
  const navigate = useNavigate();
  const [internalOpen, setInternalOpen] = useState(false);

  // 优先使用外部控制，否则使用内部 state
  const open = externalOpen !== undefined ? externalOpen : internalOpen;
  const setOpen = externalOnOpenChange ?? setInternalOpen;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 加载 Agent 列表 ──
  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await agentApi.list();
      if (resp.success && resp.data?.agents) {
        setAgents(resp.data.agents);
      }
    } catch (err) {
      console.error("[GlobalSearch] Failed to load agents:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开弹窗时加载数据
  useEffect(() => {
    if (open) {
      loadAgents();
    }
  }, [open, loadAgents]);

  // ── 全局快捷键 Ctrl+K / Cmd+K ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setOpen]);

  // ── 外部触发事件（供页面内搜索栏调用）──
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("fenix:open-global-search", handler);
    return () => window.removeEventListener("fenix:open-global-search", handler);
  }, [setOpen]);

  // ── 选中 Agent → 查找/创建环境 → 跳转 ──
  const handleSelect = useCallback(
    async (agent: AgentInfo) => {
      setOpen(false);
      try {
        // 查找已有环境
        const listResp = await envApi.list({ agentConfigId: agent.id });
        if (listResp.success && Array.isArray(listResp.data) && listResp.data.length > 0) {
          void navigate({
            to: "/agent/chat/$agentId",
            params: { agentId: listResp.data[0].id },
          });
          return;
        }

        // 创建新环境
        const createResp = await envApi.create({
          name: `env-${agent.name.toLowerCase().replace(/\s+/g, "-")}`,
          agentConfigId: agent.id,
          autoStart: true,
        });
        if (createResp.success && createResp.data) {
          void navigate({
            to: "/agent/chat/$agentId",
            params: { agentId: createResp.data.id },
          });
        } else {
          toast.error(t("globalSearch.jumpError"));
        }
      } catch (err) {
        console.error("[GlobalSearch] Failed to jump to agent:", err);
        toast.error(t("globalSearch.jumpError"));
      }
    },
    [navigate, t, setOpen],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen} showCloseButton={false}>
      <CommandInput placeholder={t("globalSearch.placeholder")} />
      <CommandList>
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {!loading && <CommandEmpty>{t("globalSearch.empty")}</CommandEmpty>}
        {!loading && agents.length > 0 && (
          <CommandGroup heading="Agents">
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                /* cmdk 内置模糊匹配：将名称 + 描述 + 模型 + ID 拼接为搜索文本 */
                value={`${agent.name} ${agent.description ?? ""} ${agent.modelLabel ?? ""} ${agent.id}`}
                onSelect={() => handleSelect(agent)}
                className="flex items-center gap-3 px-3 py-3 cursor-pointer"
              >
                <Bot className="h-4 w-4 shrink-0 text-brand" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate">
                    {agent.name}
                    {agent.builtIn && (
                      <span className="ml-1.5 text-[10px] font-semibold text-brand/70 uppercase">Built-in</span>
                    )}
                  </span>
                  {agent.description && <span className="text-xs text-text-muted truncate">{agent.description}</span>}
                </div>
                {agent.modelLabel && (
                  <span className="ml-auto shrink-0 text-[11px] text-text-muted bg-surface-1 px-1.5 py-0.5 rounded">
                    {agent.modelLabel}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
