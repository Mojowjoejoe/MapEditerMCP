$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-editor-root.ps1')
$forgeRoot = Resolve-ForgeEditorRoot
Push-Location $forgeRoot
try {
    & node node_modules/vite/bin/vite.js build --config vite.desktop.config.ts
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    & node tools/create-desktop-assets.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Asset packaging failed.' }
    $forgeDotnet = if (Test-Path './.dotnet-sdk/dotnet.exe') { './.dotnet-sdk/dotnet.exe' } else { 'dotnet' }
    & $forgeDotnet publish desktop/WulframForge/WulframForge.csproj --configuration Release --runtime win-x64 --self-contained true --output dist/desktop/mcp-v0.1.0 /p:Version=0.7.0-mcp.1
    if ($LASTEXITCODE -ne 0) { throw 'Native publish failed.' }
} finally { Pop-Location }
