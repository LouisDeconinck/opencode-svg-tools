# Install svg_render as a global OpenCode custom tool.
# Works from a repo clone or via: irm <raw-url>/install.ps1 | iex
$ErrorActionPreference = "Stop"

$RepoRaw = "https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main"
$Tool = "svg_render.ts"

# Same resolution OpenCode uses: OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~\.config
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR }
             elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME "opencode" }
             else { Join-Path $HOME ".config\opencode" }
$ToolsDir = Join-Path $ConfigDir "tools"
$Pkg = Join-Path $ConfigDir "package.json"
$Dest = Join-Path $ToolsDir $Tool

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

$Local = Join-Path (Get-Location) ".opencode\tools\$Tool"
if (Test-Path $Local) {
    Copy-Item $Local $Dest
} else {
    Invoke-WebRequest -Uri "$RepoRaw/.opencode/tools/$Tool" -OutFile $Dest
}
Write-Host "Installed $Dest"

try {
    $pkg = if ((Test-Path $Pkg) -and (Get-Content $Pkg -Raw).Trim()) {
        Get-Content $Pkg -Raw | ConvertFrom-Json
    } else {
        [pscustomobject]@{}
    }
    if (-not ($pkg.PSObject.Properties.Name -contains "dependencies")) {
        $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
    }
    $want = [ordered]@{ "@opencode-ai/plugin" = "^1.18.31"; "@resvg/resvg-js" = "^2.6.2" }
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

Write-Host "Done. Restart OpenCode to load the svg_render tool."
