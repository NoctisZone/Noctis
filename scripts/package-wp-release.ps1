<#
.SYNOPSIS
  Packages the noctis-platform / weldpress plugins and the noctis
  theme into versioned, checksummed release zips.

.DESCRIPTION
  The WordPress plugins and theme are deliberately NOT git-tracked in this
  repo (internal tracking) -- each keeps its
  own CHANGELOG.md instead, which works fine for local Preprod dev but
  left no actual path for how this code reaches a real deployment. This
  script is that path: a real, repeatable release process producing a
  clean zip per target, versioned from each target's own header, with a
  SHA-256 checksum so a deployment can verify what it's installing.

  Deliberately does NOT change the "WP code stays out of git" convention
  -- only this script (a build tool, same category as integration/build.mjs)
  is tracked. The zips themselves land in -OutputDir, which is gitignored.

.PARAMETER SourceRoot
  Path to the wp-content directory containing plugins/ and themes/.
  Defaults to this machine's Local by Flywheel site path. Override on a
  different machine/checkout with -SourceRoot.

.PARAMETER OutputDir
  Where release zips + manifest are written. Defaults to ./releases at
  the repo root (gitignored -- see .gitignore).

.PARAMETER Targets
  Which of 'noctis-platform', 'weldpress', 'noctis-theme' to package.
  Defaults to all three.

.EXAMPLE
  ./scripts/package-wp-release.ps1
  Packages all three targets using this machine's default paths.

.EXAMPLE
  ./scripts/package-wp-release.ps1 -Targets noctis-platform
  Packages just the noctis-platform plugin.
#>

param(
    [string]$SourceRoot = (Join-Path $env:USERPROFILE "Local Sites\noctis\app\public\wp-content"),
    [string]$OutputDir  = (Join-Path $PSScriptRoot "..\releases"),
    [ValidateSet('noctis-platform', 'weldpress', 'noctis-theme')]
    [string[]]$Targets  = @('noctis-platform', 'weldpress', 'noctis-theme')
)

$ErrorActionPreference = 'Stop'

# Dev cruft that must never end up in a release zip -- none of these are
# needed at runtime and some (node_modules under a theme's build tooling)
# would bloat the zip by orders of magnitude for no reason.
$ExcludeDirs  = @('.git', 'node_modules', '.idea', '.vscode')
$ExcludeFiles = @('*.log', '.DS_Store', 'Thumbs.db', 'desktop.ini', '*.zip')

function Get-PluginVersion {
    param([string]$MainFilePath)
    $content = Get-Content -Raw -Path $MainFilePath
    if ($content -match '(?m)^\s*\*\s*Version:\s*([0-9][0-9A-Za-z\.\-]*)') {
        return $Matches[1].Trim()
    }
    throw "Could not find a 'Version:' header in $MainFilePath"
}

function Get-ThemeVersion {
    param([string]$StyleCssPath)
    $content = Get-Content -Raw -Path $StyleCssPath
    if ($content -match '(?m)^\s*Version:\s*([0-9][0-9A-Za-z\.\-]*)') {
        return $Matches[1].Trim()
    }
    throw "Could not find a 'Version:' header in $StyleCssPath"
}

function Copy-CleanTree {
    param([string]$Source, [string]$Dest)
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Get-ChildItem -Path $Source -Recurse -Force | ForEach-Object {
        $rel = $_.FullName.Substring($Source.Length).TrimStart('\')
        $isExcludedDir = $ExcludeDirs | Where-Object { $rel -split '\\' -contains $_ }
        if ($isExcludedDir) { return }
        if (-not $_.PSIsContainer) {
            $name = $_.Name
            $excluded = $false
            foreach ($pattern in $ExcludeFiles) {
                if ($name -like $pattern) { $excluded = $true; break }
            }
            if ($excluded) { return }
            $destPath = Join-Path $Dest $rel
            $destDir  = Split-Path $destPath -Parent
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
            Copy-Item -Path $_.FullName -Destination $destPath -Force
        }
    }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$manifest = @()

foreach ($target in $Targets) {
    switch ($target) {
        'noctis-platform' {
            $srcDir   = Join-Path $SourceRoot 'plugins\noctis-platform'
            $mainFile = Join-Path $srcDir 'noctis-platform.php'
            $version  = Get-PluginVersion -MainFilePath $mainFile
            $zipName  = "noctis-platform-$version.zip"
            $folderName = 'noctis-platform'
        }
        'weldpress' {
            $srcDir   = Join-Path $SourceRoot 'plugins\weldpress'
            $mainFile = Join-Path $srcDir 'weld-cardano.php'
            $version  = Get-PluginVersion -MainFilePath $mainFile
            $zipName  = "weldpress-$version.zip"
            $folderName = 'weldpress'
        }
        'noctis-theme' {
            $srcDir   = Join-Path $SourceRoot 'themes\noctis'
            $styleCss = Join-Path $srcDir 'style.css'
            $version  = Get-ThemeVersion -StyleCssPath $styleCss
            $zipName  = "noctis-theme-$version.zip"
            $folderName = 'noctis'
        }
    }

    if (-not (Test-Path $srcDir)) {
        Write-Warning "Skipping '$target' -- source not found at $srcDir"
        continue
    }

    Write-Host "Packaging $target (v$version)..."

    $stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("np-release-" + [System.Guid]::NewGuid().ToString('N'))
    $stagingTarget = Join-Path $stagingRoot $folderName
    Copy-CleanTree -Source $srcDir -Dest $stagingTarget

    $zipPath = Join-Path $OutputDir $zipName
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path $stagingTarget -DestinationPath $zipPath -CompressionLevel Optimal

    Remove-Item -Recurse -Force $stagingRoot

    $hash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
    $fileCount = (Get-ChildItem -Path $srcDir -Recurse -File -Force | Where-Object {
        $rel = $_.FullName.Substring($srcDir.Length).TrimStart('\')
        -not ($ExcludeDirs | Where-Object { $rel -split '\\' -contains $_ })
    }).Count

    Write-Host "  -> $zipPath"
    Write-Host "     sha256: $hash"
    Write-Host "     files:  $fileCount"

    $manifest += [PSCustomObject]@{
        target    = $target
        version   = $version
        zip       = $zipName
        sha256    = $hash
        fileCount = $fileCount
        builtAt   = (Get-Date).ToString('o')
    }
}

$manifestPath = Join-Path $OutputDir 'manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding utf8
Write-Host ""
Write-Host "Manifest written to $manifestPath"
