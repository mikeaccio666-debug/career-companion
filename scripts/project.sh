#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_version=24.21.0
pnpm_version=11.13.1
cd "$project_root"

if [[ $# -eq 0 ]]; then
  printf '%s\n' '用法：./scripts/project.sh <pnpm 参数或项目脚本>' '例如：./scripts/project.sh check:platform' >&2
  exit 2
fi

path_node="$(command -v node || true)"
path_pnpm="$(command -v pnpm || true)"
os_arch=''
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) os_arch=darwin-arm64 ;;
  Darwin:x86_64) os_arch=darwin-x64 ;;
  Linux:x86_64) os_arch=linux-x64 ;;
  Linux:aarch64|Linux:arm64) os_arch=linux-arm64 ;;
esac

node_candidates=()
[[ -z "$path_node" ]] || node_candidates+=("$path_node")
[[ -z "$os_arch" ]] || node_candidates+=("$project_root/.local/toolchain/node-v${node_version}-${os_arch}/bin/node")
node_candidates+=("${HOME}/.local/share/career-companion/toolchain/node-v${node_version}-linux-x64/bin/node")

project_node=''
for candidate in "${node_candidates[@]}"; do
  [[ -f "$candidate" && -x "$candidate" ]] || continue
  actual_version="$("$candidate" --version 2>/dev/null || true)"
  if [[ "$actual_version" == "v${node_version}" ]]; then
    project_node="$candidate"
    break
  fi
done
if [[ -z "$project_node" ]]; then
  printf '%s\n' "未找到实际版本为 Node ${node_version} 的可执行文件。" \
    '请先单独安装项目工具链，或切换当前终端的 Node；本入口不会自动下载。' \
    '已检查当前 PATH、项目 .local/toolchain 与用户 career-companion/toolchain 目录。' >&2
  exit 1
fi

# This PATH applies only to this process and its children. No profile or system
# tools are changed, and tool-manager shims cannot download another runtime.
export PATH="$(dirname "$project_node"):$PATH"
export COREPACK_ENABLE_NETWORK=0
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export npm_config_manage_package_manager_versions=false

pnpm_candidates=()
[[ -z "$path_pnpm" ]] || pnpm_candidates+=("$path_pnpm")
pnpm_candidates+=("${HOME}/.local/share/career-companion/toolchain/pnpm-${pnpm_version}/node_modules/.bin/pnpm")

project_pnpm=''
for candidate in "${pnpm_candidates[@]}"; do
  [[ -f "$candidate" && -x "$candidate" ]] || continue
  actual_version="$("$candidate" --version 2>/dev/null || true)"
  if [[ "$actual_version" == "$pnpm_version" ]]; then
    project_pnpm="$candidate"
    break
  fi
done
if [[ -z "$project_pnpm" ]]; then
  printf '%s\n' "未找到可用的 pnpm ${pnpm_version}。" \
    '请先单独安装 pnpm，或把已有安装提供给当前终端；本入口不会运行 Corepack 下载。' >&2
  exit 1
fi

# Workspace scripts can invoke pnpm again; make the selected installation
# available to their child shells while keeping the verified Node first.
export PATH="$(dirname "$project_node"):$(dirname "$project_pnpm"):$PATH"
exec "$project_pnpm" "$@"
