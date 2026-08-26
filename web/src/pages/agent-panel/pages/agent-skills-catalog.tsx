import {
  AlertTriangle,
  ChevronDown,
  Download,
  Eye,
  FileText,
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
import { Switch } from "@/components/ui/switch";
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
        <section className="skills-directory-grid">
          {filtered.map((skill) => {
            const writable = canWriteSkill(skill);
            const manageable = canManageSkillSharing(skill);
            const external = skill.resourceAccess?.ownership === "external";
            const downloading = props.downloadingKey === getSkillKey(skill);
            return (
              <article className="skill-directory-item" key={getSkillKey(skill)}>
                <div className={`skill-directory-icon${external ? " is-shared" : ""}`}>
                  {external ? <Share2 /> : <Sparkles />}
                </div>
                <div className="skill-directory-copy">
                  <div>
                    <strong>{external ? getSkillOptionLabel(skill) : skill.name}</strong>
                    <span>{external ? t("scope.shared") : t("scope.organization")}</span>
                  </div>
                  <p>{skill.description || t("directory.noDescription")}</p>
                </div>
                <div className="skill-directory-sharing">
                  {manageable ? (
                    <label>
                      <Switch
                        aria-label={tComponents("resource.public")}
                        checked={Boolean(skill.resourceAccess?.publicReadable)}
                        onCheckedChange={() => props.onToggleSharing(skill)}
                      />
                      <span>{tComponents("resource.public")}</span>
                    </label>
                  ) : (
                    <span>{writable ? t("directory.private") : tComponents("resource.readOnly")}</span>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="skill-directory-menu" aria-label={t("btn.more")}>
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
                    {writable ? (
                      <DropdownMenuItem className="text-destructive" onClick={() => props.onDelete(skill)}>
                        <Trash2 />
                        {t("btn.delete")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
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
      <div className="mt-6 grid grid-cols-1 gap-2 xl:grid-cols-2">
        {Array.from({ length: 8 }).map((_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static loading placeholders
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
    </main>
  );
}
