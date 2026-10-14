#!/usr/bin/env bash
# 把 dsh-persona-studio 安装进一个 DSH profile（默认 desktop）。
# 幂等：重复执行只会补齐缺失的部分。改完需要重启一次 DSH。
#
# 用法： bash scripts/install.sh [profile] [dsh_home]
set -euo pipefail

PROFILE="${1:-desktop}"
DSH_HOME="${2:-${DSH_HOME:-$HOME/.dsh}}"
PKG_NAME="dsh-persona-studio"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG_JSON="$PROFILE_DIR/package.json"
PATCH_YML="$PROFILE_DIR/cordis.patch.yml"
LINK_PATH="$PROFILE_DIR/node_modules/$PKG_NAME"

echo "插件目录 : $ROOT"
echo "Profile  : $PROFILE_DIR"

if [ ! -f "$PKG_JSON" ]; then
  echo "找不到 profile 的 package.json：$PKG_JSON" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR/node_modules"

# ---- 1) 软链接（Windows 上用 junction 更简单，见 install.ps1） ----
if [ -L "$LINK_PATH" ]; then
  echo "链接已存在：$LINK_PATH -> $(readlink "$LINK_PATH")"
elif [ -e "$LINK_PATH" ]; then
  echo "目标已存在且不是链接（可能是包管理器安装的副本）：$LINK_PATH" >&2
else
  ln -s "$ROOT" "$LINK_PATH"
  echo "已创建链接：$LINK_PATH -> $ROOT"
fi

# ---- 2) package.json ----
STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$PKG_JSON" "$PKG_JSON.bak-$STAMP"

node -e '
const fs = require("fs");
const [file, pkg] = process.argv.slice(1);
const json = JSON.parse(fs.readFileSync(file, "utf8"));
json.dependencies = json.dependencies || {};
if (!json.dependencies[pkg]) {
  json.dependencies[pkg] = "0.1.0";
  console.log("已登记依赖 " + pkg);
}
const bundles = (json.dsh && json.dsh.profile && json.dsh.profile.bundles) || null;
if (!bundles) throw new Error("profile 的 package.json 缺少 dsh.profile.bundles");
if (!bundles.includes(pkg)) {
  bundles.push(pkg);
  console.log("已加入 bundle 列表");
}
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
' "$PKG_JSON" "$PKG_NAME"
echo "package.json 已更新（备份：$PKG_JSON.bak-$STAMP）"

# ---- 3) cordis.patch.yml ----
cp "$PATCH_YML" "$PATCH_YML.bak-$STAMP"
if grep -q "$PKG_NAME" "$PATCH_YML"; then
  echo "cordis.patch.yml 已包含挂载行"
else
  {
    echo ""
    echo "# dsh-persona-studio：人格编译工坊（宿主 + 主界面悬浮面板 + /persona 命令）"
    echo "- insert:"
    echo "    - id: $PKG_NAME"
    echo "      name: $PKG_NAME"
  } >> "$PATCH_YML"
  echo "已插入挂载行（备份：$PATCH_YML.bak-$STAMP）"
fi

echo ""
echo "安装完成。请重启一次 DSH，然后在主界面输入框旁寻找「人格」按钮，或输入 /persona。"
