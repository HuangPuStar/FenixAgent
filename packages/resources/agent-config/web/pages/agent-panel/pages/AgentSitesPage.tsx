import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { z } from "zod/v4";
import { agentSitesApi, type SiteApp } from "../../../api/sites";
import { AgentSiteForm, type AgentSiteFormValues, agentSiteFormSchema } from "../components/AgentSiteForm";
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
  // 表单字段由 `FormDialog` 内部的 `useForm` 持有，页面只保留这个「每次打开换一个 `key`」的计数
  // （§4.2 / §4.3）：`key` 变化 = 强制重挂载 = 全新表单实例，默认值由 `formConfig` 按本次是新建还是
  // 编辑现算，因此关闭后再打开必定是干净的表单，不需要在 `onOpenChange` 里手工清三个字段。
  const [formResetKey, setFormResetKey] = useState(0);

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

  // 保存（新建 / 更新同一入口）：入参是**已通过 zod 校验**的表单值，因此这里不再有「名称必填」这条
  // 手写校验——它此前抛在校验体里，被 `onError` 接成通用的「保存应用失败」，用户看不到真正的原因。
  const save = useRequest(
    async (values: AgentSiteFormValues) => {
      const body = {
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        visibility: values.visibility,
      };
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
    setFormResetKey((key) => key + 1);
    setEditor("create");
  };
  const openEdit = (app: SiteApp) => {
    setFormResetKey((key) => key + 1);
    setEditor(app);
  };
  // 表单配置：schema 只判合不合法、文案在字段体内按字段取 i18n 键；`onFormSubmit` 的入参是
  // `Record<string, unknown>`（`FormDialog` 的契约），按本页的域类型收窄后再用。
  // `defaultValues` 按「本次是新建还是编辑」现算：每次打开都换 `key`，表单实例在 mount 时读到这一份。
  const formConfig = useMemo(
    () => ({
      schema: agentSiteFormSchema as z.ZodType<Record<string, unknown>>,
      defaultValues: {
        name: editor === "create" ? "" : (editor?.name ?? ""),
        description: editor === "create" ? "" : (editor?.description ?? ""),
        visibility: editor === "create" ? "private" : (editor?.visibility ?? "private"),
      } as unknown as Record<string, unknown>,
      onFormSubmit: (values: Record<string, unknown>) => {
        save.run(values as unknown as AgentSiteFormValues);
      },
    }),
    [editor, save.run],
  );

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
        key={formResetKey}
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
        title={editor === "create" ? t("siteDeployment.dialog.createTitle") : t("siteDeployment.dialog.editTitle")}
        formConfig={formConfig}
        loading={save.loading}
        width="sm:max-w-lg"
      >
        <AgentSiteForm />
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
