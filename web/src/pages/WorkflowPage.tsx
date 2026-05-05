import { useState, useRef } from "react";

export function WorkflowPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleReload = () => {
    setLoading(true);
    setError(false);
    if (iframeRef.current) {
      iframeRef.current.src = "/workflow-ui/";
    }
  };

  return (
    <div className="flex h-full flex-col">
      {loading && (
        <div className="flex h-full items-center justify-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          <p className="text-sm text-text-muted">正在加载智能体编排引擎...</p>
        </div>
      )}
      {error && (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-sm text-text-muted">智能体编排引擎连接失败，请确认 acpx-g 服务已启动</p>
          <button onClick={handleReload} className="text-brand text-sm underline">重试</button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src="/workflow-ui/"
        onLoad={() => setLoading(false)}
        onError={() => setError(true)}
        className={loading || error ? "hidden" : "flex-1 w-full border-0"}
        title="智能体编排引擎"
      />
    </div>
  );
}
