/**
 * 图布局：分层（Sugiyama 的简化版）。
 *
 * 为什么是分层而不是力导向：本图的语义方向很强（编排 → 它依赖的编排/基础服务），分层能把
 * 「栈在左、基础设施在右」的阅读顺序直接画出来；节点数只有几十个，还省掉了力导向的收敛抖动。
 *
 * 步骤：
 *   1. 用 Tarjan 求强连通分量并收缩（root ↔ agent-sites 这类互相引用真实存在，不收缩会让分层死循环）；
 *   2. 在收缩后的 DAG 上做最长路径分层：没有入边的是第 0 层（纯消费方），被依赖得越深越靠右；
 *   3. 层内排序按「同目录节点聚合」的重心排序，保证服务视图里同一个编排的服务聚成一个块；
 *   4. 输出每个节点的左上角坐标，纵向上各列居中。
 */

export type LayoutNode = { id: string; width: number; height: number; cluster: string };
export type LayoutLink = { from: string; to: string };
export type LayoutResult = { positions: Map<string, { x: number; y: number }>; width: number; height: number };

const COL_GAP = 96;
const ROW_GAP = 18;

/** Tarjan（迭代版，避免大图递归爆栈）；自环与指向未知节点的边在这里被丢弃。 */
function stronglyConnectedComponents(ids: string[], adjacency: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of ids) {
    if (index.has(start)) continue;

    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbours = adjacency.get(frame.node) ?? [];

      if (frame.next < neighbours.length) {
        const neighbour = neighbours[frame.next];
        frame.next += 1;
        if (!index.has(neighbour)) {
          index.set(neighbour, counter);
          low.set(neighbour, counter);
          counter += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          work.push({ node: neighbour, next: 0 });
        } else if (onStack.has(neighbour)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(neighbour) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let popped = stack.pop();
        while (popped !== undefined) {
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
          popped = stack.pop();
        }
        components.push(component);
      }
    }
  }

  return components;
}

export function layeredLayout(nodes: LayoutNode[], links: LayoutLink[]): LayoutResult {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const seen = new Set<string>();

  for (const link of links) {
    if (!byId.has(link.from) || !byId.has(link.to) || link.from === link.to) continue;
    const key = `${link.from}|${link.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adjacency.get(link.from)?.push(link.to);
  }

  const ids = nodes.map((node) => node.id);
  const components = stronglyConnectedComponents(ids, adjacency);
  const componentOf = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const id of component) componentOf.set(id, componentIndex);
  });

  // 收缩图（去重、去自环）
  const dagOut = new Map<number, Set<number>>(components.map((_, i) => [i, new Set<number>()]));
  const dagIn = new Map<number, Set<number>>(components.map((_, i) => [i, new Set<number>()]));
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      const a = componentOf.get(from);
      const b = componentOf.get(to);
      if (a === undefined || b === undefined || a === b) continue;
      dagOut.get(a)?.add(b);
      dagIn.get(b)?.add(a);
    }
  }

  // Kahn 拓扑序 + 最长路径分层
  const layerOfComponent = new Map<number, number>(components.map((_, i) => [i, 0]));
  const remainingIn = new Map<number, number>(components.map((_, i) => [i, dagIn.get(i)?.size ?? 0]));
  const queue = components.map((_, i) => i).filter((i) => (remainingIn.get(i) ?? 0) === 0);
  for (const start of queue) layerOfComponent.set(start, 0);

  const processed = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift() ?? 0;
    if (processed.has(current)) continue;
    processed.add(current);
    for (const next of dagOut.get(current) ?? []) {
      layerOfComponent.set(next, Math.max(layerOfComponent.get(next) ?? 0, (layerOfComponent.get(current) ?? 0) + 1));
      remainingIn.set(next, (remainingIn.get(next) ?? 1) - 1);
      if ((remainingIn.get(next) ?? 0) <= 0) queue.push(next);
    }
  }

  const layerOf = new Map<string, number>();
  for (const node of nodes) layerOf.set(node.id, layerOfComponent.get(componentOf.get(node.id) ?? 0) ?? 0);

  const layerCount = Math.max(0, ...nodes.map((node) => layerOf.get(node.id) ?? 0)) + 1;
  const columns: string[][] = Array.from({ length: layerCount }, () => []);
  for (const node of nodes) columns[layerOf.get(node.id) ?? 0].push(node.id);
  for (const column of columns) column.sort((a, b) => a.localeCompare(b));

  // 层内排序：先按目录聚合，再按重心微调，保证同编排的服务块不被别的编排插花
  const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, targets] of adjacency) {
    for (const to of targets) predecessors.get(to)?.push(from);
  }

  const orderIndex = new Map<string, number>();
  for (let pass = 0; pass < 2; pass += 1) {
    for (let layer = 0; layer < columns.length; layer += 1) {
      const column = columns[layer];
      const barycenter = new Map<string, number>();
      for (const id of column) {
        const neighbours = [...(adjacency.get(id) ?? []), ...(predecessors.get(id) ?? [])];
        const indices = neighbours
          .map((neighbour) => orderIndex.get(neighbour))
          .filter((value): value is number => value !== undefined);
        barycenter.set(
          id,
          indices.length > 0
            ? indices.reduce((sum, value) => sum + value, 0) / indices.length
            : (orderIndex.get(id) ?? 0),
        );
      }
      const clusterOrder = new Map<string, { sum: number; count: number }>();
      for (const id of column) {
        const cluster = byId.get(id)?.cluster ?? id;
        const bucket = clusterOrder.get(cluster) ?? { sum: 0, count: 0 };
        bucket.sum += barycenter.get(id) ?? 0;
        bucket.count += 1;
        clusterOrder.set(cluster, bucket);
      }
      const sorted = [...column].sort((a, b) => {
        const clusterA = byId.get(a)?.cluster ?? a;
        const clusterB = byId.get(b)?.cluster ?? b;
        if (clusterA !== clusterB) {
          const avgA = (clusterOrder.get(clusterA)?.sum ?? 0) / (clusterOrder.get(clusterA)?.count ?? 1);
          const avgB = (clusterOrder.get(clusterB)?.sum ?? 0) / (clusterOrder.get(clusterB)?.count ?? 1);
          if (Math.abs(avgA - avgB) > 0.5) return avgA - avgB;
          return clusterA.localeCompare(clusterB);
        }
        const diff = (barycenter.get(a) ?? 0) - (barycenter.get(b) ?? 0);
        return Math.abs(diff) > 0.5 ? diff : a.localeCompare(b);
      });
      columns[layer] = sorted;
      sorted.forEach((id, index) => orderIndex.set(id, index));
    }
  }

  // 坐标：列宽取该层最宽节点，列内纵向堆叠后各列居中
  const columnWidths = columns.map((column) => column.reduce((max, id) => Math.max(max, byId.get(id)?.width ?? 0), 0));
  const columnHeights = columns.map(
    (column) =>
      column.reduce((total, id) => total + (byId.get(id)?.height ?? 0), 0) + Math.max(0, column.length - 1) * ROW_GAP,
  );
  const totalHeight = Math.max(0, ...columnHeights);

  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (let layer = 0; layer < columns.length; layer += 1) {
    let y = (totalHeight - columnHeights[layer]) / 2;
    for (const id of columns[layer]) {
      const node = byId.get(id);
      if (!node) continue;
      positions.set(id, { x: x + (columnWidths[layer] - node.width) / 2, y });
      y += node.height + ROW_GAP;
    }
    x += columnWidths[layer] + COL_GAP;
  }

  return { positions, width: Math.max(0, x - COL_GAP), height: totalHeight };
}
