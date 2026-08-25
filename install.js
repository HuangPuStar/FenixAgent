#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY = "konghayao/peri";
const GITHUB_API_URL = `https://api.github.com/repos/${REPOSITORY}`;
const INSTALL_DIR = process.env.PERI_INSTALL_DIR ?? join(process.env.HOME ?? "/root", ".peri");
const VERSION = process.env.PERI_INSTALL_VERSION;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_PROXY = process.env.GITHUB_PROXY;

function getPlatform() {
  const os = platform();
  const cpu = arch();
  const platformName = os === "darwin" ? "macos" : os === "win32" ? "windows" : os;
  const archName = cpu === "x64" ? "x86_64" : cpu === "arm64" ? "aarch64" : cpu;

  if (!["macos", "linux", "windows"].includes(platformName) || !["x86_64", "aarch64", "riscv64"].includes(archName)) {
    throw new Error(`不支持的平台: ${os}-${cpu}`);
  }

  return `${platformName}-${archName}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`请求 ${url} 失败: HTTP ${response.status}`);
  return response.json();
}

function withProxy(url) {
  if (!GITHUB_PROXY || !url.startsWith("https://github.com/")) return url;
  return url.replace("https://github.com", GITHUB_PROXY.replace(/\/$/, ""));
}

async function resolveRelease() {
  if (VERSION) return fetchJson(`${GITHUB_API_URL}/releases/tags/${encodeURIComponent(VERSION)}`);

  const releases = await fetchJson(`${GITHUB_API_URL}/releases?per_page=30`);
  const release = releases.find((item) => typeof item.tag_name === "string" && item.tag_name.startsWith("agent-"));
  if (!release) throw new Error("未找到 Peri 的 agent 发行版本");
  return release;
}

async function download(url, target) {
  const response = await fetch(withProxy(url));
  if (!response.ok || !response.body) throw new Error(`下载 Peri 失败: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: "w", mode: 0o600 }));
}

async function main() {
  const targetPlatform = process.env.PERI_INSTALL_PLATFORM ?? getPlatform();
  const assetName = `peri-${targetPlatform}.tar.gz`;
  const release = await resolveRelease();
  const asset = release.assets?.find((item) => item.name === assetName);
  if (!asset?.browser_download_url) throw new Error(`发行版 ${release.tag_name} 不包含 ${assetName}`);

  const versionDir = join(INSTALL_DIR, release.tag_name);
  const archive = join(versionDir, assetName);
  const binary = join(versionDir, "peri");
  const temporaryDir = join(versionDir, ".extracting");

  await mkdir(versionDir, { recursive: true });
  await download(asset.browser_download_url, archive);
  await rm(temporaryDir, { recursive: true, force: true });
  await mkdir(temporaryDir, { recursive: true });

  await execFileAsync("tar", ["-xzf", archive, "-C", temporaryDir]);
  await rename(join(temporaryDir, `peri-${targetPlatform}`), binary);
  await chmod(binary, 0o755);

  const link = join(INSTALL_DIR, "peri");
  await rm(link, { force: true });
  await symlink(binary, link);
  await writeFile(join(INSTALL_DIR, "current-version.txt"), `${release.tag_name}\n`);
  await rm(archive, { force: true });
  await rm(temporaryDir, { recursive: true, force: true });

  console.log(`Peri ${release.tag_name} 已安装至 ${link}`);
}

main().catch((error) => {
  console.error(`Peri 安装失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
