import { buildPreviewUrl, getVideoMimeType } from "./utils";

interface VideoPreviewProps {
  envId: string;
  filePath: string;
}

export function VideoPreview({ envId, filePath }: VideoPreviewProps) {
  const src = buildPreviewUrl(envId, filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "mp4";
  const mimeType = getVideoMimeType(ext);

  return (
    <div className="flex items-center justify-center h-full bg-black/90 p-4">
      <video controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }}>
        <source src={src} type={mimeType} />
      </video>
    </div>
  );
}
