import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  Eye,
  FileText,
  Globe2,
  LockKeyhole,
  type LucideIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { NS } from "../../../i18n";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillOptionLabel,
} from "../../../lib/skill-resource-access";
import { AgentPageHeader } from "../shared/AgentPageHeader";
import type { SkillCatalogScope, SkillCreateMode, SkillInfo } from "./agent-skills-types";
import { countSkillsByScope, filterSkills } from "./agent-skills-utils";
import "./agent-skills.css";

type AgentSkillsCatalogProps = {
  skills: SkillInfo[];
  loading: boolean;
  error: Error | undefined;
  query: string;
  scope: SkillCatalogScope;
  downloadingKey: string | null;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: SkillCatalogScope) => void;
  onCreate: (mode: SkillCreateMode) => void;
  onConversationCreate: () => void;
  onDownload: (skill: SkillInfo) => void;
  onOpen: (skill: SkillInfo) => void;
  onDelete: (skill: SkillInfo) => void;
  onToggleSharing: (skill: SkillInfo) => void;
  onRetry: () => void;
};

function getSkillIcon(skill: SkillInfo): LucideIcon {
  const value = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
  if (/research|检索|搜索/.test(value)) return Search;
  if (/api|code|review|代码/.test(value)) return Code2;
  if (/html|picture|browser|网页|图片/.test(value)) return Globe2;
  if (/document|文档/.test(value)) return FileText;
  return Sparkles;
}

export function AgentSkillsCatalog(props: AgentSkillsCatalogProps) {
  const { t } = useTranslation(NS.SKILLS);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const filtered = filterSkills(props.skills, props.query, props.scope);
  const { organization: organizationCount, shared: sharedCount } = countSkillsByScope(props.skills);

  if (props.loading) return <SkillsLoading />;
  if (props.error && props.skills.length === 0) {
    return (
      <main className="agent-skills-page">
        <section className="skills-load-error" role="alert">
          <AlertTriangle />
          <strong>{t("loadState.title")}</strong>
          <p>{props.error.message}</p>
          <Button onClick={props.onRetry}>
            <RefreshCw />
            {t("loadState.retry")}
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="agent-skills-page">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <Button variant="outline" className="skills-upload-button" onClick={() => props.onCreate("upload")}>
              <Upload />
              {t("btn.uploadSkill")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="skills-create-button">
                  <Plus />
                  {t("btn.createSkill")}
                  <ChevronDown className="skills-create-chevron" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => props.onCreate("text")}>
                  <FileText />
                  {t("btn.manualCreate")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={props.onConversationCreate}>
                  <Sparkles />
                  {t("btn.conversationCreate")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <section className="skills-commandbar" aria-label={t("toolbar.label")}>
        <label className="skills-search-field">
          <Search />
          <input
            aria-label={t("search")}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t("search")}
          />
        </label>
        <div className="skills-scope-filter" role="group" aria-label={t("scope.label")}>
          {(
            [
              ["all", t("scope.all"), props.skills.length],
              ["organization", t("scope.organization"), organizationCount],
              ["shared", t("scope.shared"), sharedCount],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={props.scope === value}
              onClick={() => props.onScopeChange(value)}
            >
              {label}
              <small>{count}</small>
            </button>
          ))}
        </div>
      </section>

      <header className="skills-directory-heading">
        <div>
          <h2>{t("directory.title")}</h2>
          <p>{t("directory.summary", { visible: filtered.length, total: props.skills.length })}</p>
        </div>
      </header>

      {filtered.length === 0 ? (
        <section className="skills-empty-state">
          <Sparkles />
          <strong>{props.skills.length === 0 ? t("empty") : t("emptySearch")}</strong>
          <p>{props.skills.length === 0 ? t("emptyHint") : t("emptySearchHint")}</p>
        </section>
      ) : (
        <section className="skills-directory-grid mt-3 overflow-hidden rounded-lg border border-[var(--skills-line)] bg-white shadow-sm">
          {filtered.map((skill) => {
            const writable = canWriteSkill(skill);
            const manageable = canManageSkillSharing(skill);
            const external = skill.resourceAccess?.ownership === "external";
            const downloading = props.downloadingKey === getSkillKey(skill);
            const SkillIcon = getSkillIcon(skill);
            return (
              <article
                className="skill-directory-item group grid min-h-[62px] min-w-0 grid-cols-[38px_minmax(0,1fr)_auto_30px_16px] items-center gap-3 border-[var(--skills-line)] border-b px-4 py-2 last:border-b-0 hover:bg-[#f8faff] max-[720px]:grid-cols-[38px_minmax(0,1fr)_30px_16px]"
                key={getSkillKey(skill)}
              >
                <div
                  className={
                    external
                      ? "grid size-9 place-items-center rounded-lg bg-[#f0edff] text-[#6d55c7] [&_svg]:w-4"
                      : "grid size-9 place-items-center rounded-lg bg-[var(--skills-blue-soft)] text-[var(--skills-blue)] [&_svg]:w-4"
                  }
                >
                  {external ? <Share2 /> : <SkillIcon />}
                </div>
                <button type="button" className="min-w-0 text-left" onClick={() => props.onOpen(skill)}>
                  <div className="flex min-w-0 items-center gap-2">
                    <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                      {external ? getSkillOptionLabel(skill) : skill.name}
                    </strong>
                  </div>
                  <p className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--skills-muted)] leading-[1.45]">
                    {skill.description || t("directory.noDescription")}
                  </p>
                </button>
                <div className="flex items-center gap-1.5 max-[720px]:hidden">
                  <span
                    className={
                      external
                        ? "rounded-md bg-[#f1eeff] px-2 py-1 text-[9px] text-[#6e55c7]"
                        : "rounded-md bg-[#edf5ff] px-2 py-1 text-[9px] text-[#1e72c8]"
                    }
                  >
                    {external ? t("scope.shared") : t("scope.organization")}
                  </span>
                  <span className="rounded-md bg-[#f3f5f8] px-2 py-1 text-[9px] text-[var(--skills-muted)]">
                    {skill.resourceAccess?.publicReadable
                      ? tComponents("resource.public")
                      : writable
                        ? t("directory.private")
                        : tComponents("resource.readOnly")}
                  </span>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-[30px] text-[var(--skills-muted)] opacity-0 hover:text-[var(--skills-ink)] focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [&_svg]:w-4"
                      aria-label={t("btn.more")}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={downloading} onClick={() => props.onDownload(skill)}>
                      <Download />
                      {t("btn.download")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => props.onOpen(skill)}>
                      {writable ? <Pencil /> : <Eye />}
                      {writable ? t("btn.edit") : t("btn.view")}
                    </DropdownMenuItem>
                    {manageable ? (
                      <DropdownMenuItem onClick={() => props.onToggleSharing(skill)}>
                        {skill.resourceAccess?.publicReadable ? <LockKeyhole /> : <Globe2 />}
                        {skill.resourceAccess?.publicReadable
                          ? tComponents("resource.makePrivate")
                          : tComponents("resource.makePublic")}
                      </DropdownMenuItem>
                    ) : null}
                    {writable ? (
                      <DropdownMenuItem className="text-destructive" onClick={() => props.onDelete(skill)}>
                        <Trash2 />
                        {t("btn.delete")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  className="grid size-4 place-items-center text-[var(--skills-muted)] hover:text-[var(--skills-blue)] [&_svg]:w-3.5"
                  aria-label={writable ? t("btn.edit") : t("btn.view")}
                  onClick={() => props.onOpen(skill)}
                >
                  <ChevronRight />
                </button>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

function SkillsLoading() {
  return (
    <main className="agent-skills-page" aria-busy="true">
      <div>
        <Skeleton className="h-7 w-36" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <Skeleton className="mt-5 h-10 w-full max-w-4xl" />
      <div className="mt-6 overflow-hidden rounded-lg border border-[var(--skills-line)] bg-white">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static loading placeholders
            key={index}
            className="flex h-[62px] items-center gap-3 border-[var(--skills-line)] border-b px-4 last:border-b-0"
          >
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="mt-2 h-2.5 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
