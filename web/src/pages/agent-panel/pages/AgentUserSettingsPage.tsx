import { useRequest } from "ahooks";
import imageCompression from "browser-image-compression";
import { Camera, Trash2, UserRound } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ragflowKeyApi } from "@/src/api/ragflow-key";
import { unwrap } from "@/src/api/request";
import { userProfileApi } from "@/src/api/user-profile";
import { NS } from "@/src/i18n";
import { useSession } from "@/src/lib/auth-client";
import { RagflowKeyConfig } from "../components/RagflowKeyConfig";

export function AgentUserSettingsPage() {
  const _t = useTranslation(NS.KNOWLEDGE).t;
  const { data: session } = useSession();
  const [uploading, setUploading] = useState(false);
  const [localImage, setLocalImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: profile } = useRequest(async () => unwrap(userProfileApi.getProfile()));

  // 以 API 返回的 profile 为准，localImage 用于上传后即时更新
  const userImage = localImage ?? profile?.image ?? null;
  const userName = session?.user?.name ?? profile?.name ?? "";
  const userEmail = session?.user?.email ?? profile?.email ?? "";

  const notifySidebar = useCallback(() => {
    window.dispatchEvent(new CustomEvent("avatar-updated"));
  }, []);

  const handleUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.2,
        maxWidthOrHeight: 512,
        useWebWorker: true,
        fileType: "image/webp",
      });
      // browser-image-compression 的 Web Worker 模式下可能丢失 MIME type，手动补上
      const avatar = new File([compressed], compressed.name || "avatar.webp", {
        type: compressed.type || "image/webp",
      });
      const result = await unwrap(userProfileApi.uploadAvatar(avatar));
      // 直接使用上传返回的 URL，加时间戳破缓存
      setLocalImage(`${result.image}?t=${Date.now()}`);
      toast.success("头像上传成功");
      notifySidebar();
    } catch (err) {
      toast.error(`头像上传失败: ${(err as Error).message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemove = async () => {
    try {
      await unwrap(userProfileApi.deleteAvatar());
      setLocalImage(null);
      toast.success("头像已移除");
      notifySidebar();
    } catch (err) {
      toast.error(`移除头像失败: ${(err as Error).message}`);
    }
  };

  return (
    <div className="min-h-full overflow-auto bg-[#f7f8fa] px-6 py-6 text-[#0f172a]">
      <div className="mb-8">
        <h1 className="text-[26px] font-bold tracking-tight text-[#0f172a]">个人设置</h1>
        <p className="mt-1.5 text-[13px] text-[#94a3b8]">管理个人信息与配置</p>
      </div>

      <div className="mb-6 h-px bg-gradient-to-r from-transparent via-[#e2e8f0] to-transparent" />

      <div className="max-w-2xl space-y-8">
        {/* 头像区 */}
        <div className="rounded-xl border border-[#e2e8f0] bg-white p-6">
          <h2 className="mb-1 text-[15px] font-semibold text-[#0f172a]">头像</h2>
          <p className="mb-5 text-[13px] text-[#94a3b8]">上传个人头像，支持 PNG、JPEG、WebP、GIF 格式</p>

          <div className="flex items-center gap-5">
            {/* 头像预览 */}
            <div className="relative shrink-0">
              <div className="h-20 w-20 rounded-full bg-gradient-to-br from-[#6be6ff] to-[#0f6bff] flex items-center justify-center overflow-hidden ring-2 ring-[#e2e8f0]">
                {userImage ? (
                  <img
                    src={userImage}
                    alt={userName}
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <UserRound className="h-8 w-8 text-white" />
                )}
              </div>
              {uploading && (
                <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center">
                  <div className="h-5 w-5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="flex flex-col gap-2.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                type="button"
                disabled={uploading}
                onClick={handleUpload}
                className="inline-flex items-center gap-2 rounded-lg bg-[#0f6bff] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#0b5ddb] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Camera className="h-4 w-4" />
                上传头像
              </button>
              {userImage && (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={handleRemove}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#e2e8f0] bg-white px-4 py-2 text-[13px] font-medium text-[#ef4444] transition-colors hover:bg-[#fef2f2] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="h-4 w-4" />
                  移除头像
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 用户信息区 */}
        <div className="rounded-xl border border-[#e2e8f0] bg-white p-6">
          <h2 className="mb-1 text-[15px] font-semibold text-[#0f172a]">个人信息</h2>
          <p className="mb-5 text-[13px] text-[#94a3b8]">当前账户基本信息</p>

          <div className="space-y-4">
            <div>
              <label className="block text-[12px] font-medium text-[#94a3b8] mb-1">用户名</label>
              <p className="text-[14px] text-[#0f172a]">{userName || "—"}</p>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[#94a3b8] mb-1">邮箱</label>
              <p className="text-[14px] text-[#0f172a]">{userEmail || "—"}</p>
            </div>
          </div>
        </div>

        {/* RAGFlow Key 配置 */}
        <RagflowKeyConfig
          title="个人 RAGFlow API Key"
          description="配置后可创建和使用个人知识库。请在 RAGFlow 管理后台获取 API Key。"
          fetchStatus={() => unwrap(ragflowKeyApi.getUserStatus())}
          saveKey={(key) => ragflowKeyApi.saveUserKey(key)}
          deleteKey={() => ragflowKeyApi.deleteUserKey()}
        />
      </div>
    </div>
  );
}
