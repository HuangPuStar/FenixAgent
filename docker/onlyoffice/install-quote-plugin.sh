#!/bin/sh
# 将 owner 包的资源安装到可独立分发的 Compose 组件目录。
set -eu

component_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
source_dir=${1:-"$component_dir/../../packages/file-editing/office-plugin"}
target_dir="$component_dir/plugins/conversation-quote"

for asset in config.json index.html selection.js main.js; do
  if [ ! -f "$source_dir/$asset" ]; then
    printf 'Missing OnlyOffice quote plugin asset: %s\n' "$asset" >&2
    exit 1
  fi
done

mkdir -p "$target_dir"
for asset in config.json index.html selection.js main.js; do
  cp "$source_dir/$asset" "$target_dir/$asset"
done
