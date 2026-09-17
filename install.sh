#!/usr/bin/env bash
# Install svg_render + svg_inspect + the svg-visual-feedback skill as global OpenCode extensions.
# Works from a repo clone or via: curl -fsSL <raw-url>/install.sh | bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main"
FILES=("tools/svg_render.ts" "tools/svg_inspect.ts" "skills/svg-visual-feedback/SKILL.md")

# Same resolution OpenCode uses: OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~/.config
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
PKG="$CONFIG_DIR/package.json"

# Only trust files that sit next to this script inside a real clone.
# When piped (curl | bash) BASH_SOURCE is not a file, so we always download —
# never pick up an arbitrary .opencode/ from the current working directory.
SCRIPT_DIR=""
if [ -f "${BASH_SOURCE[0]:-}" ]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$candidate/install.sh" ] && [ -f "$candidate/.opencode/${FILES[0]}" ]; then
    SCRIPT_DIR="$candidate"
  fi
fi

copy() { # copy <repo-relative> — clone files when this script came from one, else download
  local dest="$CONFIG_DIR/$1"
  mkdir -p "$(dirname "$dest")"
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/.opencode/$1" ]; then
    cp "$SCRIPT_DIR/.opencode/$1" "$dest"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "$REPO_RAW/.opencode/$1" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$REPO_RAW/.opencode/$1"
  else
    echo "error: no local clone detected and neither curl nor wget is available" >&2
    exit 1
  fi
  echo "Installed $dest"
}

for f in "${FILES[@]}"; do copy "$f"; done

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

echo "Done. Restart OpenCode to load the svg_render/svg_inspect tools and svg-visual-feedback skill."
