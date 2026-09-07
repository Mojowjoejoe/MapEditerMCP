function Resolve-ForgeEditorRoot {
    $candidate = if ($env:WULFRAM_FORGE_ROOT) { [IO.Path]::GetFullPath($env:WULFRAM_FORGE_ROOT) } else { $PSScriptRoot }
    while ($candidate) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'desktop/WulframForge/WulframForge.csproj')) { return $candidate }
        if ($env:WULFRAM_FORGE_ROOT) { break }
        $candidate = Split-Path -Parent $candidate
    }
    throw 'Set WULFRAM_FORGE_ROOT to a compatible Wulfram Forge editor checkout.'
}
