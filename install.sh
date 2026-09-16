#!/usr/bin/env bash
# Install svg_render as a global OpenCode custom tool.
# Works from a repo clone or via: curl -fsSL <raw-url>/install.sh | bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main"
TOOL="svg_render.ts"

# Same resolution OpenCode uses: OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~/.config
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
TOOLS_DIR="$CONFIG_DIR/tools"
PKG="$CONFIG_DIR/package.json"
DEST="$TOOLS_DIR/$TOOL"

mkdir -p "$TOOLS_DIR"

if [ -f ".opencode/tools/$TOOL" ]; then
  cp ".opencode/tools/$TOOL" "$DEST"
elif command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REPO_RAW/.opencode/tools/$TOOL" -o "$DEST"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$DEST" "$REPO_RAW/.opencode/tools/$TOOL"
else
  echo "error: no local .opencode/tools/$TOOL and neither curl nor wget is available" >&2
  exit 1
fi
echo "Installed $DEST"

if command -v bun >/dev/null 2>&1; then RUNTIME=bun
elif command -v node >/dev/null 2>&1; then RUNTIME=node
else RUNTIME=""; fi

if [ -n "$RUNTIME" ]; then
  "$RUNTIME" -e 'const fs=require("fs");const p=process.argv[1];const pkg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")||"{}"):{};pkg.dependencies=pkg.dependencies||{};for(const[k,v]of Object.entries({"@resvg/resvg-js":"^2.6.2","@opencode-ai/plugin":"^1.18.31"}))pkg.dependencies[k]??=v;fs.writeFileSync(p,JSON.stringify(pkg,null,2)+"\n")' "$PKG" \
    || echo "warning: could not update $PKG — add @resvg/resvg-js to its dependencies manually" >&2
elif [ ! -f "$PKG" ]; then
  printf '{\n  "dependencies": {\n    "@opencode-ai/plugin": "^1.18.31",\n    "@resvg/resvg-js": "^2.6.2"\n  }\n}\n' > "$PKG"
else
  echo "warning: neither bun nor node found — add @resvg/resvg-js to $PKG dependencies manually" >&2
fi

if command -v bun >/dev/null 2>&1; then
  (cd "$CONFIG_DIR" && bun install --silent) || echo "warning: dependency install failed; OpenCode will retry on startup" >&2
elif command -v npm >/dev/null 2>&1; then
  (cd "$CONFIG_DIR" && npm install --silent) || echo "warning: dependency install failed; OpenCode will retry on startup" >&2
fi

echo "Done. Restart OpenCode to load the svg_render tool."
