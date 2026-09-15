$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$packageRoot = Join-Path $sourceRoot 'dist/portable-0.1.0'
if ((Test-Path -LiteralPath $packageRoot) -and (Get-ChildItem -LiteralPath $packageRoot -Force)) { throw 'O pacote já existe. Use uma nova versão ou revise o diretório antes de reconstruir.' }
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
$runtimeRoot = Join-Path $sourceRoot 'node_modules/electron/dist'
if (!(Test-Path -LiteralPath $runtimeRoot)) { $runtimeRoot = Join-Path $sourceRoot 'dist/win-unpacked' }
Get-ChildItem -LiteralPath $runtimeRoot | Where-Object { $_.Name -ne 'resources' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $packageRoot -Recurse }
Copy-Item -LiteralPath (Join-Path $packageRoot 'electron.exe') -Destination (Join-Path $packageRoot 'OS4 Publicador.exe')
$appRoot = Join-Path $packageRoot 'resources/app'
New-Item -ItemType Directory -Path (Join-Path $appRoot 'node_modules') -Force | Out-Null
foreach ($item in @('src','vendor','package.json')) { Copy-Item -LiteralPath (Join-Path $sourceRoot $item) -Destination $appRoot -Recurse }
foreach ($item in @('playwright','playwright-core')) { Copy-Item -LiteralPath (Join-Path $sourceRoot "node_modules/$item") -Destination (Join-Path $appRoot 'node_modules') -Recurse }
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'resources/browser') -Force | Out-Null
foreach ($item in @('chromium-1243','ffmpeg-1011')) { Copy-Item -LiteralPath (Join-Path $sourceRoot "browser/$item") -Destination (Join-Path $packageRoot 'resources/browser') -Recurse }
Write-Output "Pacote pronto: $packageRoot"
