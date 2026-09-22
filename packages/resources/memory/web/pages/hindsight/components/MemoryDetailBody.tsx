import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Calendar, Check, Copy, Users } from "lucide-react";
import type { MemoryDetail } from "../types";

/**
 * 记忆详情的**正文**（字段区）——详情弹窗与图谱节点详情面板共用。
 *
 * 两份外壳此前各写一份逐字同构的正文：同一个 `getMemoryTypeTitle()`、同一批字段区、同一套
 * class 串，任何一侧改动都要手工同步另一侧（`entities` 的归一化就只加了面板一侧）。
 * 这里收口正文，两个外壳只留自己真正的差异：弹窗的 `Dialog` 外壳、面板的面板/紧凑外壳。
 *
 * 字段标签**不进本模块**：两侧的字典键不同（`memoryDetailModal.*` / `memoryDetailPanel.*`），
 * 由调用方翻译好经 `labels` 传入——共享件若自己读字典，又会把某一侧的键变成另一侧的隐式依赖，
 * 正是这次要修掉的那类问题（见 `../memory-type-title.ts`）。
 *
 * 两套排版用 `variant` 选择，class 串逐字取自迁移前的两份实现：弹窗紧凑（字段间距 4、
 * 实体为小胶囊、编号不可复制），面板宽松（间距 5、实体为圆角胶囊、编号可复制）。
 */

/**
 * 正文的数据形状：`MemoryDetail` 的字段，但 `entities` 与 `fact_type` 放宽——
 * 图谱行（`MemoryTableRow`）经 `MemoryDetail & MemoryTableRow` 交叉后 `entities` 被收窄成
 * `string[]`，而运行时的两种形态（数组 / `a, b` 字符串）都要认，故此处显式放宽。
 */
export type MemoryDetailView = Omit<MemoryDetail, "entities"> & {
  entities?: unknown;
  fact_type?: string;
  node_id?: string;
};

/** 字段标签：由调用方用自己的字典键翻译后传入。 */
export interface MemoryDetailBodyLabels {
  text: string;
  context: string;
  occurred: string;
  mentioned: string;
  entities: string;
  tags: string;
  memoryId: string;
}

export type MemoryDetailBodyVariant = "modal" | "panel";

interface MemoryDetailBodyStyle {
  container: string;
  /** 字段标签（下间距 2）。 */
  label: string;
  /** 上下文 / 编号的字段标签：弹窗用 1 档（与它的密排一致），面板与其余标签同档。 */
  labelTight: string;
  /** 实体字段标签：两套实现的图标与下间距不同。 */
  entityLabel: string;
  textValue: string;
  contextValue: string;
  entityList: string;
  entityChip: string;
  idCode: string;
  /** 实体标签是否带 `Users` 图标（面板的字段标签不带图标）。 */
  entityIcon: boolean;
  /** 面板不给观察类型显示上下文（弹窗一直显示）。 */
  hideObservationContext: boolean;
  /** 编号是否带复制按钮（只有面板给了复制入口）。 */
  copyableId: boolean;
}

const BODY_STYLES: Record<MemoryDetailBodyVariant, MemoryDetailBodyStyle> = {
  modal: {
    container: "flex-1 overflow-y-auto space-y-4 pr-2",
    label: "text-xs font-bold text-muted-foreground uppercase mb-2",
    labelTight: "text-xs font-bold text-muted-foreground uppercase mb-1",
    entityLabel: "text-xs font-bold text-muted-foreground uppercase mb-2 flex items-center gap-1",
    textValue: "text-sm text-foreground leading-relaxed",
    contextValue: "text-sm text-foreground",
    entityList: "flex flex-wrap gap-1.5",
    entityChip: "px-2 py-0.5 bg-primary/10 text-primary rounded text-xs",
    idCode: "text-xs font-mono text-muted-foreground break-all",
    entityIcon: true,
    hideObservationContext: false,
    copyableId: false,
  },
  panel: {
    container: "space-y-5",
    label: "text-xs font-bold text-muted-foreground uppercase mb-2",
    labelTight: "text-xs font-bold text-muted-foreground uppercase mb-2",
    entityLabel: "text-xs font-bold text-muted-foreground uppercase mb-3",
    textValue: "text-sm whitespace-pre-wrap leading-relaxed text-foreground",
    contextValue: "text-sm text-foreground",
    entityList: "flex flex-wrap gap-2",
    entityChip: "text-sm px-3 py-1.5 rounded-full bg-primary/10 text-primary font-medium",
    idCode: "text-xs font-mono text-muted-foreground",
    entityIcon: false,
    hideObservationContext: true,
    copyableId: true,
  },
};

export interface MemoryDetailBodyProps {
  memory: MemoryDetailView;
  labels: MemoryDetailBodyLabels;
  variant: MemoryDetailBodyVariant;
  /** 编号的复制入口；不传时即使 `variant="panel"` 也不渲染复制按钮。 */
  onCopyId?: (memoryId: string) => void;
  /** 已复制的编号（用于把复制图标换成对勾）；与 `onCopyId` 同属调用方的状态。 */
  copiedId?: string | null;
  className?: string;
}

/** 正文外层容器：沿用调用方外壳的滚动/间距 class。 */
export function MemoryDetailBody({ memory, labels, variant, onCopyId, copiedId, className }: MemoryDetailBodyProps) {
  const style = BODY_STYLES[variant];
  const entityLabels = toEntityLabels(memory.entities);
  const memoryId = memory.id || memory.node_id;
  const isObservation = memory.fact_type === "observation" || memory.type === "observation";

  return (
    <div className={className ? `${style.container} ${className}` : style.container}>
      {/* 文本 */}
      <section>
        <div className={style.label}>{labels.text}</div>
        <div className={style.textValue}>{memory.text}</div>
      </section>

      {/* 上下文 */}
      {memory.context && !(style.hideObservationContext && isObservation) && (
        <section>
          <div className={style.labelTight}>{labels.context}</div>
          <div className={style.contextValue}>{memory.context}</div>
        </section>
      )}

      {/* 日期 */}
      {memory.occurred_start && (
        <section>
          <div className={style.label}>{labels.occurred}</div>
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span>
              {new Date(memory.occurred_start).toLocaleString()}
              {memory.occurred_end && memory.occurred_end !== memory.occurred_start && (
                <>
                  <span className="text-muted-foreground mx-1">→</span>
                  {new Date(memory.occurred_end).toLocaleString()}
                </>
              )}
            </span>
          </div>
        </section>
      )}

      {memory.mentioned_at && (
        <section>
          <div className={style.label}>{labels.mentioned}</div>
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span>{new Date(memory.mentioned_at).toLocaleString()}</span>
          </div>
        </section>
      )}

      {/* 实体 */}
      {entityLabels.length > 0 && (
        <section>
          <div className={style.entityLabel}>
            {style.entityIcon && <Users className="w-3 h-3" />}
            {labels.entities}
          </div>
          <div className={style.entityList}>
            {entityLabels.map((entity) => (
              <span key={entity} className={style.entityChip}>
                {entity}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 标签 */}
      {memory.tags && memory.tags.length > 0 && (
        <section>
          <div className={style.label}>{labels.tags}</div>
          <div className="flex flex-wrap gap-1">
            {memory.tags.map((tag: string) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* 编号 */}
      {memoryId && (
        <section>
          <div className={style.labelTight}>{labels.memoryId}</div>
          <div className="flex items-center gap-2">
            <code className={style.idCode}>{memoryId}</code>
            {style.copyableId && onCopyId && (
              <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => onCopyId(memoryId)}>
                {copiedId === memoryId ? (
                  <Check className="h-3 w-3 text-green-600" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground" />
                )}
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * 归一实体标签：后端给过三种形态——`MemoryDetail.entities` 是字符串数组、图谱行给 `a, b` 字符串、
 * 实体对象数组（`{ name }`）。三条分支此前只存在于面板（弹窗直接按 `string[]` 渲染，遇到对象会渲染成
 * `[object Object]`），这里按并集处理：拿不到名字的对象退化成 JSON 文本，不吞掉信息。
 */
function toEntityLabels(entities: unknown): string[] {
  if (Array.isArray(entities)) {
    return entities.map((entity) => {
      if (typeof entity === "string") return entity;
      const name = (entity as { name?: unknown } | null)?.name;
      if (typeof name === "string") return name;
      return JSON.stringify(entity) ?? "";
    });
  }
  if (typeof entities === "string" && entities.trim()) return entities.split(", ");
  return [];
}
