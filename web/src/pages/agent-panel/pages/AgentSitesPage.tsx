import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { agentSitesApi, type SiteApp } from "@/src/api/sites";
import { NS } from "@/src/i18n";
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
      toast.error(t("siteDeployment.errors.loadWith", { message: error.message }));
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
        toast.error(error.message);
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
    onError: (error) => toast.error(t("siteDeployment.errors.deleteWith", { message: error.message })),
  });

  const rotateToken = useRequest((app: SiteApp) => unwrap(agentSitesApi.rotateToken(app.id)), {
    manual: true,
    onSuccess: () => toast.success(t("siteDeployment.toast.tokenRotated")),
    onError: (error) => toast.error(t("siteDeployment.errors.rotateWith", { message: error.message })),
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
      if (!environment) throw new Error(t("siteDeployment.errors.creatorInactive"));
      void navigate({ to: "/agent/$agentId", params: { agentId: environment.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("siteDeployment.errors.creatorNavigation"));
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
        onOpen={(app) => window.open(`/web/site/deploy/${app.remoteAppId}/`, "_blank", "noopener,noreferrer")}
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
