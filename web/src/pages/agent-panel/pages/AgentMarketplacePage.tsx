import { useRequest } from "ahooks";
import { Bot, ExternalLink, FileJson, Gem, Loader2, MessageCircle, Search, Sparkles, Store } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type AgentMarketplaceItem, agentMarketplaceApi } from "@/src/api/agent-marketplace";
import { unwrap } from "@/src/api/request";
import { type AgentConfigSnapshotView, AgentFormDialog } from "../AgentFormDialog";
import { AgentPageHeader } from "../shared/AgentPageHeader";

type FilterId = "all" | "external" | "published";

const iconMap = {
  chatgpt: MessageCircle,
  claude: Sparkles,
  gemini: Gem,
  perplexity: Search,
  manus: Bot,
  "file-json": FileJson,
  "message-circle": MessageCircle,
  sparkles: Sparkles,
  search: Search,
  gem: Gem,
  bot: Bot,
} as const;

function MarketplaceIcon({ item }: { item: AgentMarketplaceItem }) {
  const Icon = iconMap[(item.icon ?? "bot") as keyof typeof iconMap] ?? Bot;
  return (
    <div
      className={[
        "flex h-11 w-11 items-center justify-center rounded-lg border",
        item.type === "published"
          ? "border-[#b9d7ff] bg-[#eaf4ff] text-[#1677ff]"
          : "border-[#dfe7f1] bg-white text-[#4f607b]",
      ].join(" ")}
    >
      <Icon className="h-5 w-5" />
    </div>
  );
}

function MarketplaceCard({
  item,
  onViewConfig,
}: {
  item: AgentMarketplaceItem;
  onViewConfig: (item: AgentMarketplaceItem) => void;
}) {
  const isPublished = item.type === "published";
  const accentClass = isPublished ? "from-[#eaf4ff] via-white to-[#f6fbff]" : "from-[#f7f9ff] via-white to-[#f8fbf3]";
  const iconBackdropClass = isPublished
    ? "border-[#a9cdfd] bg-[#dcebff] text-[#1677ff] shadow-[0_8px_18px_rgba(22,119,255,0.12)]"
    : "border-[#d5deeb] bg-[#f6f8fb] text-[#40516b] shadow-[0_8px_18px_rgba(64,81,107,0.08)]";

  return (
    <div
      className={[
        "group relative flex min-h-[226px] overflow-hidden rounded-lg border border-[#dce5ef] bg-white shadow-[0_8px_24px_rgba(20,33,61,0.05)] transition",
        "hover:-translate-y-0.5 hover:border-[#bfd3ec] hover:shadow-[0_14px_34px_rgba(20,33,61,0.1)]",
      ].join(" ")}
    >
      <div className={`absolute inset-x-0 top-0 h-24 bg-gradient-to-br ${accentClass}`} />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#b9cee8] to-transparent opacity-70" />
      <div className="relative flex min-h-full w-full flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className={["rounded-xl border p-1 transition group-hover:scale-[1.02]", iconBackdropClass].join(" ")}>
            <MarketplaceIcon item={item} />
          </div>
          <span
            className={[
              "inline-flex h-6 items-center rounded-md px-2 text-[11px] font-semibold",
              isPublished ? "bg-[#eaf4ff] text-[#1677ff]" : "bg-[#f3f6fa] text-[#65748a]",
            ].join(" ")}
          >
            {isPublished ? "已发布" : "外部"}
          </span>
        </div>
        <div className="mt-4 min-w-0">
          <h3 className="truncate text-[16px] font-semibold text-[#14213d]">{item.name}</h3>
          <p className="mt-2 line-clamp-3 min-h-[60px] text-[13px] leading-5 text-[#65748a]">
            {item.description || "暂无描述"}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {item.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-md border border-white/70 bg-white/75 px-2 py-1 text-[11px] font-medium text-[#607089] shadow-[0_1px_3px_rgba(20,33,61,0.04)]"
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="mt-auto pt-5">
          {item.canOpen && item.externalUrl ? (
            <Button asChild className="h-9 w-full bg-[#1677ff] text-[13px] hover:bg-[#0f67df]">
              <a href={item.externalUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                打开链接
              </a>
            </Button>
          ) : item.canViewConfig ? (
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full border-[#cfdced] bg-white/80 text-[13px] text-[#31506f] hover:border-[#9fc5f4] hover:bg-white hover:text-[#1677ff]"
              onClick={() => onViewConfig(item)}
            >
              <FileJson className="h-4 w-4" />
              查看配置
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full cursor-default border-[#d9e3ef] bg-white/70 text-[13px] text-[#718198] hover:bg-white/70 hover:text-[#718198]"
            >
              <Bot className="h-4 w-4" />
              推荐 Agent
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentMarketplacePage() {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [configItem, setConfigItem] = useState<AgentMarketplaceItem | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<AgentConfigSnapshotView | null>(null);

  const { data: items = [], loading } = useRequest(async () => unwrap(agentMarketplaceApi.list()), {
    onError: (err) => {
      console.error("Failed to load agent marketplace:", err);
      toast.error("加载智能体广场失败");
    },
  });

  const { loading: loadingConfig, run: runLoadConfig } = useRequest(
    async (id: string) => unwrap(agentMarketplaceApi.getConfig(id)) as Promise<AgentConfigSnapshotView>,
    {
      manual: true,
      onSuccess: (data) => {
        setConfigSnapshot(data);
      },
      onError: (err) => {
        console.error("Failed to load published agent config:", err);
        toast.error("加载发布配置失败");
        setConfigItem(null);
        setConfigSnapshot(null);
      },
    },
  );

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFilter = activeFilter === "all" || item.type === activeFilter;
      const matchesQuery =
        normalized.length === 0 ||
        item.name.toLowerCase().includes(normalized) ||
        (item.description ?? "").toLowerCase().includes(normalized) ||
        item.tags.some((tag) => tag.toLowerCase().includes(normalized));
      return matchesFilter && matchesQuery;
    });
  }, [activeFilter, items, query]);

  const handleViewConfig = (item: AgentMarketplaceItem) => {
    setConfigItem(item);
    setConfigSnapshot(null);
    runLoadConfig(item.id);
  };

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title="智能体广场"
        subtitle="浏览常用智能体，也可以查看组织内发布的智能体配置"
        actions={
          <div className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#d0d9e8] bg-white px-4 text-[13px] font-semibold text-[#4f607b]">
            <Store className="h-4 w-4 text-[#1677ff]" />
            {items.length} 个智能体
          </div>
        }
      />

      <div className="mb-7 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a8bd]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索智能体、标签或描述..."
            className="h-10 w-full rounded-lg border border-[#dce5ef] bg-white pl-10 pr-4 text-[13px] text-[#1a2944] outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
          />
        </div>
        {[
          { id: "all", label: "全部" },
          { id: "external", label: "热门智能体" },
          { id: "published", label: "已发布" },
        ].map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => setActiveFilter(filter.id as FilterId)}
            className={[
              "rounded-full px-3.5 py-1.5 text-[12px] font-medium transition",
              activeFilter === filter.id
                ? "bg-[#1677ff] text-white shadow-[0_4px_10px_rgba(22,119,255,0.18)]"
                : "border border-[#e0e7f0] bg-white text-[#6f7f95] hover:border-[#b9cee8] hover:text-[#1677ff]",
            ].join(" ")}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex h-72 items-center justify-center text-[#7f8da4]">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          加载智能体广场...
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="flex h-72 flex-col items-center justify-center rounded-lg border border-dashed border-[#d8e2ef] bg-white/65 text-[#8a9ab0]">
          <Store className="mb-3 h-10 w-10 opacity-50" />
          <div className="text-[15px] font-semibold text-[#56667d]">暂无智能体</div>
          <div className="mt-1 text-[13px]">调整搜索条件或发布一个智能体</div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5">
          {filteredItems.map((item) => (
            <MarketplaceCard key={item.id} item={item} onViewConfig={handleViewConfig} />
          ))}
        </div>
      )}

      {loadingConfig && configItem && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="flex h-32 w-72 items-center justify-center rounded-lg border border-[#dce5ef] bg-white text-[13px] font-medium text-[#65748a] shadow-xl">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#1677ff]" />
            加载配置...
          </div>
        </div>
      )}
      <AgentFormDialog
        open={!!configItem && !!configSnapshot}
        onOpenChange={(open) => {
          if (!open) {
            setConfigItem(null);
            setConfigSnapshot(null);
          }
        }}
        mode="edit"
        agentName={configSnapshot?.name ?? configItem?.name}
        snapshot={configSnapshot}
        readOnlyTitle="智能体配置"
      />
    </div>
  );
}
