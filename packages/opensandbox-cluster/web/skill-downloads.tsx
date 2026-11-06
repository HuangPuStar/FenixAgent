import { Download } from "lucide-react";
import { Button } from "./components";
import { t } from "./i18n";

/** Download the skill described by the surrounding resource manual. */
export function SkillDownload({ name }: { name: "deploy-opensandbox-node" | "use-opensandbox-sandbox" }) {
  return (
    <Button asChild variant="outline">
      <a href={`/skills/${name}/download`} download={`${name}.tar.gz`}>
        <Download size={16} aria-hidden />
        {name === "deploy-opensandbox-node" ? t("下载节点部署 Skill") : t("下载沙盒使用 Skill")}
      </a>
    </Button>
  );
}
