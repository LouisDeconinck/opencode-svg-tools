# Install svg_render + svg_inspect + the svg-visual-feedback skill as global OpenCode extensions.
# Works from a repo clone or via: irm <raw-url>/install.ps1 | iex
$ErrorActionPreference = "Stop"

$RepoRaw = "https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main"
$Files = @("tools/svg_render.ts", "tools/svg_inspect.ts", "tools/svg_compare.ts", "skills/svg-visual-feedback/SKILL.md")

# Same resolution OpenCode uses: OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~\.config
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR }
             elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME "opencode" }
             else { Join-Path $HOME ".config\opencode" }
$Pkg = Join-Path $ConfigDir "package.json"

# Only trust files that sit next to this script inside a real clone.
# When piped (irm | iex) there is no script path, so we always download —
# never pick up an arbitrary .opencode\ from the current working directory.
$ScriptDir = $null
if ($MyInvocation.MyCommand.Path) {
    $candidate = Split-Path -Parent $MyInvocation.MyCommand.Path
    if ((Test-Path (Join-Path $candidate "install.ps1")) -and
        (Test-Path (Join-Path $candidate ".opencode\tools\svg_render.ts"))) {
        $ScriptDir = $candidate
    }
}

foreach ($f in $Files) {
    $dest = Join-Path $ConfigDir ($f -replace "/", "\")
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    $local = if ($ScriptDir) { Join-Path $ScriptDir (".opencode\" + ($f -replace "/", "\")) } else { $null }
    if ($local -and (Test-Path $local)) {
        Copy-Item $local $dest
    } else {
        Invoke-WebRequest -Uri "$RepoRaw/.opencode/$f" -OutFile $dest
    }
    Write-Host "Installed $dest"
}

try {
    $pkg = if ((Test-Path $Pkg) -and (Get-Content $Pkg -Raw).Trim()) {
        Get-Content $Pkg -Raw | ConvertFrom-Json
    } else {
        [pscustomobject]@{}
    }
    if (-not ($pkg.PSObject.Properties.Name -contains "dependencies")) {
        $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
    }
    # resvg is pinned exactly — overwrite any existing range so rerunning this
    # installer migrates users off ^2.x (2.7+ may change behavior we rely on).
    $pkg.dependencies | Add-Member -Force -NotePropertyName "@resvg/resvg-js" -NotePropertyValue "2.6.2"
    $want = [ordered]@{ "@opencode-ai/plugin" = "^1.18.31" }
    foreach ($k in $want.Keys) {
        if (-not ($pkg.dependencies.PSObject.Properties.Name -contains $k)) {
            $pkg.dependencies | Add-Member -NotePropertyName $k -NotePropertyValue $want[$k]
        }
    }
    $pkg | ConvertTo-Json -Depth 20 | Set-Content -Path $Pkg -Encoding utf8
    Write-Host "Updated dependencies in $Pkg"
} catch {
    Write-Warning "Could not update $Pkg — add '@resvg/resvg-js' to its dependencies manually."
}

try {
    Push-Location $ConfigDir
    if (Get-Command bun -ErrorAction SilentlyContinue) {
        bun install --silent
    } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
        npm install --silent
    }
    Pop-Location
} catch {
    Pop-Location
    Write-Warning "Dependency install failed; OpenCode will retry on startup."
}

Write-Host "Done. Restart OpenCode to load the svg_render/svg_inspect/svg_compare tools and svg-visual-feedback skill."
