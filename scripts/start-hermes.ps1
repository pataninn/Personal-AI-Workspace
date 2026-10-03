param(
    [string]$Distribution = 'Ubuntu',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$environmentFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw 'Create .env from .env.example and configure the workspace and local secrets first.'
}
if ($repositoryRoot -notmatch '^([A-Za-z]):\\') { throw 'This startup helper expects a Windows drive path.' }
$wslRepository = '/mnt/' + $Matches[1].ToLowerInvariant() + $repositoryRoot.Substring(2).Replace('\', '/')

Push-Location $repositoryRoot
try {
    if (-not $SkipBuild) {
        docker build -f docker/hermes.Dockerfile -t personal-ai-hermes:0.20.6-pai1 .
        if ($LASTEXITCODE -ne 0) { throw 'The pinned Hermes image could not be built.' }
    }
    $imageDigest = (docker image inspect personal-ai-hermes:0.20.6-pai1 --format '{{.Id}}').Trim()
    if ($LASTEXITCODE -ne 0 -or $imageDigest -notmatch '^sha256:[0-9a-f]{64}$') { throw 'The pinned Hermes image is unavailable.' }
    wsl -d $Distribution -- python3 "$wslRepository/deploy/hermes-bridge/setup.py" "$wslRepository/secrets/hermes-bridge" $imageDigest
    if ($LASTEXITCODE -ne 0) { throw 'Hermes bridge startup failed. Check the installed OpenShell gateway in WSL.' }

    $environmentText = [IO.File]::ReadAllText($environmentFile)
    if ($environmentText -match '(?m)^AGENT_RUNTIME_MODE=') {
        $environmentText = [regex]::Replace($environmentText, '(?m)^AGENT_RUNTIME_MODE=.*$', 'AGENT_RUNTIME_MODE=hermes')
    } else { $environmentText = $environmentText.TrimEnd() + "`nAGENT_RUNTIME_MODE=hermes`n" }
    [IO.File]::WriteAllText($environmentFile, $environmentText, [Text.UTF8Encoding]::new($false))

    if ($SkipBuild) { docker compose -p personal-ai-workspace up -d --no-build --wait --wait-timeout 180 }
    else { docker compose -p personal-ai-workspace up -d --build --wait --wait-timeout 180 }
    if ($LASTEXITCODE -ne 0) { throw 'The app did not become healthy. Check Docker Compose status.' }
    Write-Host 'Hermes is ready: https://127.0.0.1:8443/'
} finally { Pop-Location }
