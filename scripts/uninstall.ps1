<#
.SYNOPSIS
  从 DSH profile 卸载 dsh-persona-studio（保留人格库数据）。

.EXAMPLE
  pwsh -File scripts/uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$pkgName = 'dsh-persona-studio'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgJson = Join-Path $profileDir 'package.json'
$patchYml = Join-Path $profileDir 'cordis.patch.yml'
$linkPath = Join-Path $profileDir 'node_modules\dsh-persona-studio'

# ⚠️ 写文件必须用这个函数：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写入 BOM，
# 而 BOM 会让 profile 的 package.json / cordis.patch.yml 解析失败。
function Write-Utf8NoBom {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
    Remove-Item $linkPath -Force
    Write-Host "已移除联接：$linkPath"
  } else {
    Write-Host "保留非联接目录（可能由包管理器安装）：$linkPath"
  }
}

if (Test-Path $pkgJson) {
  Copy-Item $pkgJson "$pkgJson.bak-$stamp" -Force
  $json = Get-Content -Raw -Encoding UTF8 $pkgJson | ConvertFrom-Json
  if ($json.dependencies -and $json.dependencies.$pkgName) {
    $json.dependencies.PSObject.Properties.Remove($pkgName)
  }
  if ($json.dsh.profile.bundles) {
    $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $pkgName })
  }
  # 管道输出不会自动绑到函数参数上，必须先收进变量（同 install.ps1）
  $jsonText = $json | ConvertTo-Json -Depth 12
  Write-Utf8NoBom -Path $pkgJson -Text $jsonText
  Write-Host "package.json 已清理（备份：$pkgJson.bak-$stamp）"
}

if (Test-Path $patchYml) {
  Copy-Item $patchYml "$patchYml.bak-$stamp" -Force
  $lines = Get-Content -Encoding UTF8 $patchYml
  $kept = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $pkgName) {
      # 跳过挂载行；若前一行是 "- insert:" 且它只服务这一个插件，也一并跳过
      if ($kept.Count -gt 0 -and $kept[-1] -match '^\s*-\s*insert:\s*$') {
        $kept = $kept[0..($kept.Count - 2)]
      }
      continue
    }
    $kept += $lines[$i]
  }
  Write-Utf8NoBom -Path $patchYml -Text (($kept -join "`r`n") + "`r`n")
  Write-Host "cordis.patch.yml 已清理（备份：$patchYml.bak-$stamp）"
}

if ($RemoveData) {
  $dataDir = Join-Path $DshHome 'persona'
  if (Test-Path $dataDir) {
    Remove-Item -Recurse -Force $dataDir
    Write-Host "已删除人格库数据：$dataDir"
  }
} else {
  Write-Host "人格库数据保留在：$(Join-Path $DshHome 'persona')（需要删除请加 -RemoveData）"
}

Write-Host '卸载完成，重启 DSH 后生效。'
