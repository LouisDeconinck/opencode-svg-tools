# Install svg_render + the svg-visual-feedback skill as global OpenCode extensions.
# Works from a repo clone or via: irm <raw-url>/install.ps1 | iex
$ErrorActionPreference = "Stop"

$RepoRaw = "https://raw.githubusercontent.com/LouisDeconinck/opencode-svg-tools/main"
$Files = @("tools/svg_render.ts", "skills/svg-visual-feedback/SKILL.md")

# Same resolution OpenCode uses: OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~\.config
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR }
             elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME "opencode" }
             else { Join-Path $HOME ".config\opencode" }
$Pkg = Join-Path $ConfigDir "package.json"

foreach ($f in $Files) {
    $local = Join-Path (Get-Location) (".opencode\" + ($f -replace "/", "\"))
    $dest = Join-Path $ConfigDir ($f -replace "/", "\")
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    if (Test-Path $local) {
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

Write-Host "Done. Restart OpenCode to load the svg_render tool and svg-visual-feedback skill."
