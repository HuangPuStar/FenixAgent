/** Read-only context-window usage shown beside composer capabilities. */
export function ComposerContextMeter({ percentage }: { percentage: number }) {
  const normalizedPercentage = Math.max(0, Math.min(100, Math.round(percentage)));

  return (
    <div
      className="chat-demo__composer-context-meter"
      role="meter"
      aria-label={`上下文窗口已使用 ${normalizedPercentage}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalizedPercentage}
      title={`上下文窗口已使用 ${normalizedPercentage}%`}
    >
      <span className="chat-demo__context-ring" aria-hidden="true">
        <svg viewBox="0 0 20 20">
          <circle className="chat-demo__context-ring-track" cx="10" cy="10" r="7" pathLength="100" />
          <circle
            className="chat-demo__context-ring-value"
            cx="10"
            cy="10"
            r="7"
            pathLength="100"
            strokeDasharray={`${normalizedPercentage} 100`}
          />
        </svg>
      </span>
      <span className="chat-demo__context-meter-label">上下文</span>
      <strong>{normalizedPercentage}%</strong>
    </div>
  );
}
