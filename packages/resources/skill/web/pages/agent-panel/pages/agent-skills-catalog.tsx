import { MessageResponse } from "@fenix/ui-components/chat/primitives/message";
import {
  AgentMasterDetailHeader,
  AgentMasterDetailWorkspace,
} from "@fenix/ui-components/components/agent-master-detail-workspace";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { ScopeFilterBar, type ScopeFilterOption } from "@fenix/ui-components/config/ScopeFilterBar";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import type { SkillDetail as SkillDetailData } from "@fenix/web-runtime/types/config";
import {
  AlertTriangle,
  ChevronRight,
  Code2,
  Download,
  Eye,
  FileText,
  Globe2,
  LockKeyhole,
  type LucideIcon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillOptionLabel,
  isExternalSkill,
  isPublicSkill,
} from "../../../lib/skill-resource-access";
import type { SkillCatalogScope, SkillCreateMode, SkillInfo } from "./agent-skills-types";
import { countSkillsByScope, filterSkills, isSkillAccessDenied } from "./agent-skills-utils";
import "./agent-skills.css";

type AgentSkillsCatalogProps = {
  skills: SkillInfo[];
  /** 当前组织 id；归属判定与「本组织」筛选依据，缺失时按本组织保守处理。 */
  activeOrganizationId?: string;
  loading: boolean;
  error: Error | undefined;
  query: string;
  scope: SkillCatalogScope;
  downloadingKey: string | null;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: SkillCatalogScope) => void;
  onCreate: (mode: SkillCreateMode) => void;
  onDownload: (skill: SkillInfo) => void;
  onOpen: (skill: SkillInfo) => void;
  onDelete: (skill: SkillInfo) => void;
  onToggleSharing: (skill: SkillInfo) => void;
  onRetry: () => void;
  onLoadDetail: (skill: SkillInfo) => Promise<SkillDetailData>;
};

function getSkillIcon(skill: SkillInfo): LucideIcon {
  const value = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
  if (/research|检索|搜索/.test(value)) return Search;
  if (/api|code|review|代码/.test(value)) return Code2;
  if (/html|picture|browser|网页|图片/.test(value)) return Globe2;
  if (/document|文档/.test(value)) return FileText;
  return Sparkles;
}

function getSkillDisplayName(skill: SkillInfo): {
  name: string;
  namespace: string | null;
} {
  const label = getSkillOptionLabel(skill);
  const separator = label.lastIndexOf("/");
  if (separator < 0) return { name: label, namespace: null };
  return {
    name: label.slice(separator + 1),
    namespace: label.slice(0, separator),
  };
}

export function AgentSkillsCatalog(props: AgentSkillsCatalogProps) {
  const { t } = useTranslation(NS.SKILLS);
  const filtered = filterSkills(props.skills, props.query, props.scope, props.activeOrganizationId);
  const { organization: organizationCount, public: publicCount } = countSkillsByScope(
    props.skills,
    props.activeOrganizationId,
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const selectedSkill = filtered.find((skill) => getSkillKey(skill) === selectedKey) ?? filtered[0] ?? null;

  useEffect(() => {
    if (selectedSkill && selectedKey !== getSkillKey(selectedSkill)) setSelectedKey(getSkillKey(selectedSkill));
  }, [selectedKey, selectedSkill]);

  useEffect(() => {
    if (!selectedSkill) return;
    let current = true;
    setDetail(null);
    setDetailError(false);
    setDetailLoading(true);
    props
      .onLoadDetail(selectedSkill)
      .then((result) => {
        if (current) setDetail(result);
      })
      .catch(() => {
        if (current) setDetailError(true);
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [props.onLoadDetail, selectedSkill]);

  if (props.loading) return <SkillsLoading />;
  // 无权限（401/403，见 `isSkillAccessDenied`）整页接管：此时目录、详情与顶部创建/导入入口都会被
  // 同一守卫拒绝，渲染半个页面只会剩下一排点了没反应的按钮。**刻意不给重试按钮**——授权失败是稳定
  // 结论而不是瞬时故障，重试只会把用户引向无意义的重复请求；真正要做的是重新登录或找组织管理员。
  if (props.error && props.skills.length === 0 && isSkillAccessDenied(props.error)) {
    return (
      <AppPage className="agent-skills-page">
        <EmptyState
          icon={<ShieldAlert />}
          title={t("accessDenied.title")}
          description={t("accessDenied.description")}
          tone="danger"
          role="alert"
          className="flex min-h-96 flex-col items-center justify-center"
        />
      </AppPage>
    );
  }
  if (props.error && props.skills.length === 0) {
    return (
      <AppPage className="agent-skills-page">
        <EmptyState
          icon={<AlertTriangle />}
          title={t("loadState.title")}
          description={props.error.message}
          tone="danger"
          role="alert"
          className="flex min-h-96 flex-col items-center justify-center"
          action={{ label: t("loadState.retry"), onClick: props.onRetry, icon: <RefreshCw /> }}
        />
      </AppPage>
    );
  }

  // 作用域清单与展示文案归本页所有（组件只负责渲染）：`satisfies` 保留字面量类型，
  // 让下面的回调可以按本页的联合类型收窄，而不是把 `string` 漏进业务状态。
  const scopeOptions = [
    { value: "all", label: t("scope.all"), count: props.skills.length },
    { value: "organization", label: t("scope.organization"), count: organizationCount },
    { value: "public", label: t("scope.public"), count: publicCount },
  ] satisfies readonly ScopeFilterOption[];

  return (
    <AppPage className="agent-skills-page">
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => props.onCreate("upload")}>
              <Upload />
              {t("btn.uploadSkill")}
            </Button>
            <Button size="sm" onClick={() => props.onCreate("text")}>
              <Plus />
              {t("btn.createSkill")}
            </Button>
          </>
        }
      />

      {/* 工具栏的地标名由调用方给出：`role="search"` 与 `aria-label` 都是根节点透传属性，
          原来承载这层语义的 `<section aria-label>` 已随重复实现一起收敛进组件。 */}
      <ScopeFilterBar
        role="search"
        aria-label={t("toolbar.label")}
        query={props.query}
        onQueryChange={props.onQueryChange}
        placeholder={t("search")}
        searchLabel={t("search")}
        scopes={scopeOptions}
        scope={props.scope}
        // 组件只透传字符串（它不认识业务作用域），取值来自上面的同一份清单，此处按本页联合类型收窄。
        onScopeChange={(value) => props.onScopeChange(value as SkillCatalogScope)}
        scopeGroupLabel={t("scope.label")}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Sparkles />}
          title={props.skills.length === 0 ? t("empty") : t("emptySearch")}
          description={props.skills.length === 0 ? t("emptyHint") : t("emptySearchHint")}
          className="flex min-h-80 flex-col items-center justify-center"
        />
      ) : (
        <AgentMasterDetailWorkspace
          detailHeader={selectedSkill ? <SkillDetailView skill={selectedSkill} props={props} headerOnly /> : null}
          detailFooter={selectedSkill ? <SkillDetailActions skill={selectedSkill} props={props} /> : null}
          index={
            <aside className="px-2.5 py-4.75">
              <header className="px-2 pb-3.5">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <strong>{t("directory.title")}</strong>
                  <span className="grid h-5 min-w-5.5 place-items-center rounded-sm bg-slate-200 text-3xs text-[var(--skills-muted)]">
                    {filtered.length}
                  </span>
                </div>
                <small className="mt-1 block text-3xs text-[var(--skills-faint)]">
                  {t("directory.summary", {
                    visible: filtered.length,
                    total: props.skills.length,
                  })}
                </small>
              </header>
              <nav className="grid gap-0.75" aria-label={t("directory.title")}>
                {filtered.map((skill) => {
                  const external = isExternalSkill(skill, props.activeOrganizationId);
                  const SkillIcon = getSkillIcon(skill);
                  const display = getSkillDisplayName(skill);
                  const active = getSkillKey(skill) === getSkillKey(selectedSkill);
                  const organizationName = skill.organizationName ?? t("scope.organization");
                  const publiclyReadable = isPublicSkill(skill);
                  return (
                    <button
                      type="button"
                      key={getSkillKey(skill)}
                      aria-current={active ? "page" : undefined}
                      className={`skills-directory-item grid min-h-14.25 min-w-0 items-center gap-2 rounded-md border-0 p-2 text-left ${active ? "bg-indigo-50 text-[var(--skills-blue)]" : "text-[var(--skills-muted)] hover:bg-white"}`}
                      onClick={() => setSelectedKey(getSkillKey(skill))}
                    >
                      <span className="skills-directory-item-icon grid size-7 place-items-center rounded-md bg-white">
                        {external ? <Share2 /> : <SkillIcon />}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[var(--skills-ink)]">
                          {display.name}
                        </strong>
                        <small className="mt-0.75 overflow-hidden text-ellipsis whitespace-nowrap text-3xs text-[var(--skills-faint)]">
                          {skill.description || t("directory.noDescription")}
                        </small>
                      </span>
                      <span className="flex min-w-0 flex-col items-end gap-1 text-3xs leading-none">
                        {display.namespace ? (
                          <span
                            className="max-w-32 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--skills-muted)]"
                            title={organizationName}
                          >
                            {display.namespace}
                          </span>
                        ) : null}
                        {external && !publiclyReadable ? (
                          <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-1 text-blue-700">
                            {t("scope.shared")}
                          </span>
                        ) : null}
                        {publiclyReadable ? (
                          <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-1 text-blue-700">
                            {t("scope.public")}
                          </span>
                        ) : null}
                      </span>
                      <ChevronRight className={`w-3 ${active ? "opacity-100" : "opacity-0"}`} />
                    </button>
                  );
                })}
              </nav>
            </aside>
          }
        >
          {selectedSkill ? (
            <SkillDetailView
              skill={selectedSkill}
              props={props}
              detail={detail}
              loading={detailLoading}
              error={detailError}
            />
          ) : null}
        </AgentMasterDetailWorkspace>
      )}
    </AppPage>
  );
}

function SkillDetailView({
  skill,
  props,
  headerOnly = false,
  detail = null,
  loading = false,
  error = false,
}: {
  skill: SkillInfo;
  props: AgentSkillsCatalogProps;
  headerOnly?: boolean;
  detail?: SkillDetailData | null;
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useTranslation(NS.SKILLS);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const writable = canWriteSkill(skill);
  const external = isExternalSkill(skill, props.activeOrganizationId);
  const SkillIcon = getSkillIcon(skill);
  const display = getSkillDisplayName(skill);
  const organizationName = skill.organizationName ?? t("scope.organization");
  const publiclyReadable = isPublicSkill(skill);
  const header = (
    <AgentMasterDetailHeader className="flex items-center justify-between gap-6 border-b border-[var(--skills-line)] px-8 py-6">
      <div className="flex min-w-0 items-center gap-4">
        <span className="skills-detail-icon grid size-14 shrink-0 place-items-center rounded-lg bg-[var(--skills-blue-soft)] text-[var(--skills-blue)]">
          {external ? <Share2 /> : <SkillIcon />}
        </span>
        <div className="min-w-0">
          <h2 className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-xl font-bold text-[var(--skills-ink)]">
            {display.name}
          </h2>
          <div className="flex items-center gap-2 text-3xs text-[var(--skills-faint)]">
            <span className="max-w-64 overflow-hidden text-ellipsis whitespace-nowrap" title={organizationName}>
              {organizationName}
            </span>
            {external ? (
              <span className="shrink-0 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-3xs font-medium text-blue-700">
                {t("scope.shared")}
              </span>
            ) : null}
            {publiclyReadable ? (
              <span className="shrink-0 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-3xs font-medium text-blue-700">
                {t("scope.public")}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => props.onOpen(skill)}>
        {writable ? <Pencil /> : <Eye />}
        {writable ? t("btn.edit") : t("btn.view")}
      </Button>
    </AgentMasterDetailHeader>
  );
  if (headerOnly) return header;
  return (
    <article className="min-w-0">
      <div className="p-8">
        <section className="rounded-lg bg-slate-50 px-5 py-4">
          <span className="text-3xs font-bold tracking-widest text-[var(--skills-blue)] uppercase">Skill</span>
          <p className="mt-3 max-w-3xl text-xs leading-6 text-[var(--skills-muted)]">
            {skill.description || t("directory.noDescription")}
          </p>
        </section>
        <section className="mt-6 border-t border-[var(--skills-line)] pt-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold text-[var(--skills-ink)]">{t("detail.contentTitle")}</h3>
              <p className="mt-1 text-3xs text-[var(--skills-faint)]">{t("detail.contentHint")}</p>
            </div>
            <span className="rounded bg-slate-100 px-2 py-1 font-mono text-3xs text-slate-500">SKILL.md</span>
          </div>
          {loading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          ) : error ? (
            <div
              className="flex items-center justify-between rounded-lg bg-orange-50 px-4 py-3 text-3xs text-yellow-700"
              role="alert"
            >
              <span>{t("detail.loadError")}</span>
              <Button variant="ghost" size="xs" onClick={() => props.onOpen(skill)}>
                {t("btn.view")}
              </Button>
            </div>
          ) : (
            <MessageResponse className="skills-detail-markdown">
              {detail?.content || t("detail.emptyContent")}
            </MessageResponse>
          )}
        </section>
        <div className="mt-7 flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-gray-100 px-2.5 py-1.5 text-3xs text-[var(--skills-muted)]">
            {isPublicSkill(skill)
              ? tComponents("resource.public")
              : writable
                ? t("directory.private")
                : tComponents("resource.readOnly")}
          </span>
        </div>
      </div>
    </article>
  );
}

function SkillDetailActions({ skill, props }: { skill: SkillInfo; props: AgentSkillsCatalogProps }) {
  const { t } = useTranslation(NS.SKILLS);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const writable = canWriteSkill(skill);
  const manageable = canManageSkillSharing(skill);
  const downloading = props.downloadingKey === getSkillKey(skill);

  return (
    <div className="flex items-center gap-2 border-t border-[var(--skills-line)] px-8 py-4">
      <Button variant="outline" size="sm" disabled={downloading} onClick={() => props.onDownload(skill)}>
        <Download /> {t("btn.download")}
      </Button>
      {manageable ? (
        <Button variant="ghost" size="sm" onClick={() => props.onToggleSharing(skill)}>
          {isPublicSkill(skill) ? <LockKeyhole /> : <Globe2 />}
          {isPublicSkill(skill) ? tComponents("resource.makePrivate") : tComponents("resource.makePublic")}
        </Button>
      ) : null}
      {writable ? (
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => props.onDelete(skill)}>
          <Trash2 /> {t("btn.delete")}
        </Button>
      ) : null}
    </div>
  );
}

function SkillsLoading() {
  return (
    // `busy` 只挂在骨架态：`aria-busy="true"` 常驻会让屏幕阅读器把已加载页面当成持续更新中的区域，
    // 而骨架行本身没有可访问文本，需要一个繁忙标记让读屏用户知道「内容还在来」。
    <AppPage className="agent-skills-page" busy>
      <div>
        <Skeleton className="h-7 w-36" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <Skeleton className="mt-5 h-10 w-full max-w-4xl" />
      <div className="mt-6 overflow-hidden rounded-lg border border-[var(--skills-line)] bg-white">
        {Array.from({ length: 8 }, (_, index) => `skill-loading-row-${index}`).map((rowKey) => (
          <div
            // 骨架占位行无领域标识，键由行下标派生：`key={index}` 会被 biome 的 lint/suspicious/noArrayIndexKey 拦下。
            key={rowKey}
            className="flex h-15.5 items-center gap-3 border-[var(--skills-line)] border-b px-4 last:border-b-0"
          >
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="mt-2 h-2.5 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    </AppPage>
  );
}
