<#
.SYNOPSIS
  把 dsh-persona-studio 安装进一个 DSH profile（默认 desktop）。

.DESCRIPTION
  做三件事（幂等，可重复执行）：
    1) 在 <profile>\node_modules 下建立指向本仓库的目录联接（junction）；
    2) 在 <profile>\package.json 的 dependencies 与 dsh.profile.bundles 里登记包名；
    3) 在 <profile>\cordis.patch.yml 里插入挂载行。
  改完需要重启一次 DSH（bundle 列表在启动时解析）。

.EXAMPLE
  pwsh -File scripts/install.ps1
  pwsh -File scripts/install.ps1 -Profile web -DshHome C:\Users\me\.dsh
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgJson = Join-Path $profileDir 'package.json'
$patchYml = Join-Path $profileDir 'cordis.patch.yml'
$linkPath = Join-Path $profileDir 'node_modules\dsh-persona-studio'
$pkgName = 'dsh-persona-studio'

Write-Host "插件目录 : $root"
Write-Host "Profile  : $profileDir"

# ⚠️ 必须用这个写法写文件。
# Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` **会加 BOM**（开头一个不可见字符），
# 而 BOM 会让 JSON.parse 直接报错 —— profile 的 package.json 与 cordis.patch.yml
# 只要带上 BOM，DSH 就会出现"插件没生效但不报错"甚至起不来。
# 这里显式用不带 BOM 的 UTF-8 编码写入。
function Write-Utf8NoBom {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

if (-not (Test-Path $pkgJson)) {
  throw "找不到 profile 的 package.json：$pkgJson（请用 -Profile 指定正确的 profile 名）"
}

# ---- 1) 目录联接 ----
New-Item -ItemType Directory -Force -Path (Join-Path $profileDir 'node_modules') | Out-Null
if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
    Write-Host "联接已存在：$linkPath -> $($item.Target)"
  } elseif ($Force) {
    Write-Host "移除已存在的真实目录（-Force）：$linkPath"
    Remove-Item -Recurse -Force $linkPath
    New-Item -ItemType Junction -Path $linkPath -Target $root | Out-Null
    Write-Host "已重建联接。"
  } else {
    Write-Host "目标已存在且不是联接（可能是 pnpm 安装的副本）。加 -Force 覆盖，或手工处理。" -ForegroundColor Yellow
  }
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $root | Out-Null
  Write-Host "已创建联接：$linkPath -> $root"
}

# ---- 2) package.json ----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgJson "$pkgJson.bak-$stamp" -Force
$json = Get-Content -Raw -Encoding UTF8 $pkgJson | ConvertFrom-Json
if (-not $json.dependencies) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
if (-not $json.dependencies.$pkgName) {
  $json.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue '0.1.0'
  Write-Host "已登记依赖 $pkgName"
} else {
  Write-Host "依赖已存在：$pkgName"
}
if (-not $json.dsh -or -not $json.dsh.profile -or -not $json.dsh.profile.bundles) {
  throw "profile 的 package.json 缺少 dsh.profile.bundles，无法登记 bundle。"
}
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains $pkgName) {
  $json.dsh.profile.bundles = @($bundles + $pkgName)
  Write-Host "已加入 bundle 列表"
} else {
  Write-Host "bundle 列表已包含 $pkgName"
}
# 注意：PowerShell 的管道输出**不会**自动绑到普通函数的第一个参数上，
# 必须先把内容收进变量再按名字传（写成 `... | Write-Utf8NoBom $pkgJson` 会报"缺少 Text 参数"）。
$jsonText = $json | ConvertTo-Json -Depth 12
Write-Utf8NoBom -Path $pkgJson -Text $jsonText
Write-Host "package.json 已更新（备份：$pkgJson.bak-$stamp）"

# ---- 3) cordis.patch.yml ----
Copy-Item $patchYml "$patchYml.bak-$stamp" -Force
$patch = Get-Content -Raw -Encoding UTF8 $patchYml
if ($patch -match [regex]::Escape($pkgName)) {
  Write-Host "cordis.patch.yml 已包含挂载行"
} else {
  $block = @(
    '',
    '# dsh-persona-studio：人格编译工坊（宿主 + 主界面悬浮面板 + /persona 命令）',
    '- insert:',
    "    - id: $pkgName",
    "      name: $pkgName"
  ) -join "`r`n"
  # 追加时同样不能带 BOM
  $merged = $patch.TrimEnd() + "`r`n" + $block + "`r`n"
  Write-Utf8NoBom -Path $patchYml -Text $merged
  Write-Host "已插入挂载行（备份：$patchYml.bak-$stamp）"
}

Write-Host ''
Write-Host '安装完成。请重启一次 DSH，然后打开主界面：' -ForegroundColor Green
Write-Host '  · 输入框工具栏右侧（或右下角）会出现「人格」按钮'
Write-Host '  · 或在对话里输入 /persona 查看当前人格'
