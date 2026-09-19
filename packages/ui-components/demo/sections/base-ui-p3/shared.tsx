import type { ReactNode } from "react";

/**
 * Base UI P3 各子文件共用的展示结构件，不属于包公开面。
 *
 * 原先 primitives 与 forms 两个分区各自持有一份完全相同的实现，合并到本层是为了让
 * 「小节 / 示例」两级的排版只有一处定义，避免子文件拆分后两份结构件各自漂移。
 */

/** 组件小节：h2 标题 + 说明 + 若干示例。 */
export function ComponentBlock({
  name,
  description,
  children,
}: {
  name: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="demo-example">
      <h2 className="demo-example-title">{name}</h2>
      <p className="demo-hint">{description}</p>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </div>
  );
}

/** 小节内的单个示例：h3 标题 + 说明 + 并排演示区。children 直接进入 flex 演示区。 */
export function Example({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="demo-hint">{description}</p>
      <div className="demo-row mt-3">{children}</div>
    </section>
  );
}
