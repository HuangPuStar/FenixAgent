import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentSitesApi, type SiteApp } from "../../../api/sites";
import { AgentSitesCatalog, type SiteVisibilityFilter } from "./agent-sites-catalog";

const PAGE_SIZE = 20;

export function AgentSitesPage() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<SiteVisibilityFilter>("all");
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<"create" | SiteApp | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SiteApp | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formVisibility, setFormVisibility] = useState<SiteApp["visibility"]>("private");

  const catalog = useRequest(async () => unwrap(agentSitesApi.list()), {
    onError: (error) => {
      console.error(t("siteDeployment.errors.load"), error);
      // 目录的持久失败块只在 `apps.length === 0` 时渲染（见 agent-sites-catalog），已有数据时刷新
      // 失败就只有这条 toast；两者都走字典文案，原始 `ApiError.message` 只在上一行进日志（§9.3）。
      toast.error(t("siteDeployment.errors.load"));
    },
  });
  const apps = catalog.data ?? [];
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return apps.filter((app) => {
      if (visibility !== "all" && app.visibility !== visibility) return false;
      if (!keyword) return true;
      return [app.name, app.remoteAppId, app.description, app.createdByAgentConfigName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [apps, query, visibility]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const save = useRequest(
    async () => {
      if (!name.trim()) throw new Error(t("siteDeployment.errors.nameRequired"));
      const body = { name: name.trim(), description: description.trim() || undefined, visibility: formVisibility };
      return editor === "create"
        ? unwrap(agentSitesApi.create(body))
        : editor
          ? unwrap(agentSitesApi.update(editor.id, body))
          : undefined;
    },
    {
      manual: true,
      onSuccess: () => {
        toast.success(editor === "create" ? t("siteDeployment.toast.created") : t("siteDeployment.toast.updated"));
        setEditor(null);
        catalog.refresh();
      },
      onError: (error) => {
        console.error(t("siteDeployment.errors.save"), error);
        toast.error(t("siteDeployment.errors.save"));
      },
    },
  );

  const remove = useRequest((app: SiteApp) => unwrap(agentSitesApi.delete(app.id)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("siteDeployment.toast.deleted"));
      setDeleteTarget(null);
      catalog.refresh();
    },
    onError: (error) => {
      console.error(t("siteDeployment.errors.delete"), error);
      toast.error(t("siteDeployment.errors.delete"));
    },
  });

  const rotateToken = useRequest((app: SiteApp) => unwrap(agentSitesApi.rotateToken(app.id)), {
    manual: true,
    onSuccess: () => toast.success(t("siteDeployment.toast.tokenRotated")),
    onError: (error) => {
      console.error(t("siteDeployment.errors.rotate"), error);
      toast.error(t("siteDeployment.errors.rotate"));
    },
  });

  const openCreate = () => {
    setName("");
    setDescription("");
    setFormVisibility("private");
    setEditor("create");
  };
  const openEdit = (app: SiteApp) => {
    setName(app.name);
    setDescription(app.description ?? "");
    setFormVisibility(app.visibility);
    setEditor(app);
  };
  const openCreator = async (app: SiteApp) => {
    if (!app.createdByAgentConfigId) return;
    try {
      const environments = await unwrap(envApi.list());
      const environment = environments.find((item) => item.agentConfigId === app.createdByAgentConfigId);
      if (!environment) {
        // 「创建者智能体未激活」是查得到的业务结论，不是接口失败：它有自己的字典文案，直接上屏。
        // 此前它与 `envApi.list()` 的异常共用一条 catch，于是把「未激活」和「后端报错」混成一句
        // `err.message` 回显（§9.3）。
        toast.error(t("siteDeployment.errors.creatorInactive"));
        return;
      }
      void navigate({ to: "/agent/$agentId", params: { agentId: environment.id } });
    } catch (error) {
      // 只剩取环境列表的失败：`ApiError.message` 是后端信封原文，只进日志，上屏用本页通用文案。
      console.error(t("siteDeployment.errors.creatorNavigation"), error);
      toast.error(t("siteDeployment.errors.creatorNavigation"));
    }
  };

  return (
    <>
      <AgentSitesCatalog
        apps={paged}
        loading={catalog.loading}
        error={catalog.error}
        query={query}
        visibility={visibility}
        page={page}
        totalPages={totalPages}
        onQueryChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
        onVisibilityChange={(value) => {
          setVisibility(value);
          setPage(1);
        }}
        onPageChange={setPage}
        onCreate={openCreate}
        onEdit={openEdit}
        onDelete={setDeleteTarget}
        onRotateToken={rotateToken.run}
        onCreatorOpen={(app) => void openCreator(app)}
        onRetry={catalog.refresh}
      />
      <FormDialog
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
        title={editor === "create" ? t("siteDeployment.dialog.createTitle") : t("siteDeployment.dialog.editTitle")}
        onSubmit={save.run}
        loading={save.loading}
        width="sm:max-w-lg"
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="site-name">{t("siteDeployment.form.name")}</Label>
            <Input
              id="site-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("siteDeployment.form.namePlaceholder")}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="site-description">{t("siteDeployment.form.description")}</Label>
            <Textarea
              id="site-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("siteDeployment.form.descriptionPlaceholder")}
              rows={3}
            />
          </div>
          <div className="grid gap-2">
            <Label>{t("siteDeployment.visibility.label")}</Label>
            <Select value={formVisibility} onValueChange={(value) => setFormVisibility(value as SiteApp["visibility"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["private", "org", "authenticated", "public"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`siteDeployment.visibility.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormDialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("siteDeployment.dialog.deleteTitle")}
        description={t("siteDeployment.dialog.deleteDescription", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        loading={remove.loading}
        onConfirm={() => deleteTarget && remove.run(deleteTarget)}
      />
    </>
  );
}
