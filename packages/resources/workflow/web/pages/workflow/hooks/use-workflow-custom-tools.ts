import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect } from "react";
import { type CustomToolItem, customToolsApi } from "../../../api/workflow-defs";
import { setToolColors } from "../nodes";

/**
 * custom 工具注册表：palette 的 custom 分区与节点配置里的工具下拉都要它。
 *
 * 取数走 `useRequest`（§3.4）——这份数据只有本 hook 一个所有者（没有任何其他写入点），
 * 是 §3.6 记的 6 处手写取数里唯一能直接换成 `useRequest` 的一处；其余几处要写的是跨组件共享的
 * 运行视图态 / 编辑器定义态，换了会给同一份状态造出第二个所有者（理由见
 * `use-workflow-run-transport.ts` 与 `use-workflow-draft.ts` 的文件头）。
 *
 * 失败时 `data` 保持 undefined，palette 的 custom 分区与下拉的候选项随之为空——这是**刻意的降级**，
 * 与「把故障说成确实没有数据」不同：custom 分区只是「能拖什么」的便捷入口，隐藏后编辑器照常可用
 * （节点配置里仍可手填工具名）。加可见的失败态属于产品决策，不在结构重构范围内。
 */
export function useWorkflowCustomTools(): CustomToolItem[] {
  const { data } = useRequest(() => unwrap(customToolsApi.list()), {
    onError: (err) => {
      console.error("Failed to load custom tools:", err);
    },
  });

  // 空结果的稳定引用：避免未取到数据时每帧生成新数组，让下面的同步 effect 反复触发
  const customTools = data ?? NO_CUSTOM_TOOLS;

  // 同步工具颜色到 WorkflowNode 的模块级缓存
  useEffect(() => {
    setToolColors(customTools);
  }, [customTools]);

  return customTools;
}

const NO_CUSTOM_TOOLS: CustomToolItem[] = [];
