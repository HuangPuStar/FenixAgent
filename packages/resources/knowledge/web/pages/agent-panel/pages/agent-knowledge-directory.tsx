import {
  AgentCatalogIndex,
  AgentCatalogIndexArrow,
  AgentCatalogIndexCopy,
  AgentCatalogIndexIcon,
  AgentCatalogIndexItem,
  AgentCatalogIndexNav,
} from "@fenix/ui-components/components/agent-catalog-index";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { getStatusTone } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { StatusDot } from "@fenix/ui-components/ui/status-dot";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { BookOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { KnowledgeBaseInfo } from "../../../types/knowledge";
import { KnowledgeLoadFailure } from "./agent-knowledge-load-failure";
import { KB_STATUS_TONES } from "./knowledge-status";

interface AgentKnowledgeDirectoryProps {
  items: KnowledgeBaseInfo[];
  selectedId: string | null;
  loading: boolean;
  error: unknown;
  canManage: boolean;
  onRetry: () => void;
  onSelect: (item: KnowledgeBaseInfo) => void;
  onDelete: (item: KnowledgeBaseInfo) => void;
}

/**
 * 知识库目录栏。
 *
 * 目录头部、四列模板、两行截断、条目三态配色与箭头显隐都归 `AgentCatalogIndex` 一族，取值在它的
 * 伴生 CSS 里（2026-09-23 起五页同一份）。留在本页的只有两件**页面语义**：目录级三态（加载 / 失败 /
 * 空）仍然画在目录栏**内部**（共享组件的 `children` 是自由内容，不必学技能库/MCP/模型库改成页面级
 * 提前返回，那是各页既有的形态差异）；行尾删除按钮渲染在条目按钮**之外**（`shell` + `trailing`，
 * 按钮里套按钮是非法 HTML），以及该行「远端已消失」时的不可用态。两者的样式在 `agent-knowledge.css`。
 */
export function AgentKnowledgeDirectory(props: AgentKnowledgeDirectoryProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  return (
    <AgentCatalogIndex className="knowledge-directory" title={t("directory.title")} count={props.items.length}>
      {props.loading ? (
        <div
          className="knowledge-directory__loading"
          role="status"
          aria-busy="true"
          aria-label={t("directory.loading")}
        >
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : props.error ? (
        <KnowledgeLoadFailure
          error={props.error}
          title={t("loadError")}
          onRetry={props.onRetry}
          className="px-2 py-8"
        />
      ) : props.items.length === 0 ? (
        <EmptyState className="px-2 py-8" title={t("emptyMessage")} />
      ) : (
        <AgentCatalogIndexNav label={t("directory.title")}>
          {props.items.map((item) => {
            const active = item.id === props.selectedId;
            const unavailable = item.remoteExists === false;
            return (
              <AgentCatalogIndexItem
                key={item.id}
                // 四列模板（图标 / 文案 / 尾注 / 箭头）是默认档：本页没有尾注内容，尾注列因此是空列，
                // 箭头列与其他四页一致（此前本页用 `columns="icon-copy"` 两列版，选中行尾没有箭头）。
                selected={active}
                // `selected` 只产出 `aria-current="page"`：选中底色/文字色与箭头显隐都由共享 CSS
                // 按这个属性驱动，本页此前的 `is-active` 类已删除。外壳只留「不可用」这一个本页状态。
                aria-disabled={unavailable}
                onClick={() => props.onSelect(item)}
                shellClassName={`knowledge-directory-item ${unavailable ? "is-unavailable" : ""}`}
                // 行尾删除按钮必须渲染在条目 `<button>` **之外**（按钮里套按钮是非法 HTML，浏览器会把
                // 内层按钮甩到外层之外，点击区与焦点顺序都会错），共享组件为此给了「外壳 + trailing」。
                //
                // `shell` 是独立开关，与「这一行有没有动作」解耦：外壳正是本页悬停/选中底色的落点，
                // 因此**每一行都要有外壳**，哪怕该行没有删除按钮——那种行传 `trailing={null}` 即可
                // （不再靠「传了 null 才算给了 trailing」这种隐式技巧；不写 `shell` 就没有外壳，
                // 也编译不过 `trailing`）。
                shell
                trailing={
                  unavailable && props.canManage ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-red-500"
                      aria-label={t("btn.delete")}
                      onClick={() => props.onDelete(item)}
                    >
                      <Trash2 />
                    </Button>
                  ) : null
                }
              >
                <AgentCatalogIndexIcon>
                  <BookOpen />
                </AgentCatalogIndexIcon>
                <AgentCatalogIndexCopy
                  className="knowledge-directory-item__copy"
                  title={item.name}
                  subtitle={
                    <>
                      {/* 纯装饰圆点：不传 `label` 故整块 `aria-hidden`（旁边的资源数已承担可读信息），
                          6px 装饰尺度由 `size-1.5` 覆盖库默认的 8px；色调查本包唯一词表。 */}
                      <StatusDot tone={getStatusTone(item.status, KB_STATUS_TONES)} className="size-1.5" />
                      {t("card.resourcesUnit", { count: item.resourcesCount })}
                    </>
                  }
                />
                <AgentCatalogIndexArrow />
              </AgentCatalogIndexItem>
            );
          })}
        </AgentCatalogIndexNav>
      )}
    </AgentCatalogIndex>
  );
}
