export function parseConfigView(pathname: string): string | null {
  const configViews = [
    "models",
    "agents",
    "skills",
    "knowledge-bases",
    "mcp",
    "tasks",
    "channels",
    "workflow",
    "environments",
    "organizations",
  ];
  const segment = pathname.replace(/^\/ctrl\/?/, "").split("/")[0];
  return configViews.includes(segment) ? segment : null;
}
