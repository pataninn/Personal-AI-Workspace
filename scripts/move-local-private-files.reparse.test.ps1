$ErrorActionPreference = 'Stop'

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$fixtureRoot = Join-Path $tempBase ('PersonalAIReparsePolicyTest-' + [guid]::NewGuid().ToString('N'))
$repositoryRoot = Join-Path $fixtureRoot 'OneDrive/Me/new/Repository'
$repositoryCloudFilePaths = @(
  (Join-Path $repositoryRoot '.env'),
  (Join-Path $repositoryRoot 'secrets/local_user_password'),
  (Join-Path $repositoryRoot 'secrets/nvidia_api_key'),
  (Join-Path $repositoryRoot 'docker/certs/tls.crt'),
  (Join-Path $repositoryRoot 'docker/certs/tls.key')
)
$markerPath = Join-Path $repositoryRoot '.personal-ai-workspace-identity'
$junctionPath = Join-Path $fixtureRoot 'junction'

try {
  New-Item -ItemType Directory -Force (Join-Path $repositoryRoot 'secrets'), (Join-Path $repositoryRoot 'docker/certs'), (Join-Path $fixtureRoot 'junction-target') | Out-Null

  $helperPath = Join-Path $PSScriptRoot 'move-local-private-files.ps1'
  $parseErrors = $null
  $helperAst = [System.Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$null, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) {
    throw 'The relocation helper has PowerShell syntax errors.'
  }

  $addTypeCommand = $helperAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type'
  }, $true)
  Invoke-Expression $addTypeCommand.Extent.Text

  foreach ($functionName in @('Test-PathInside', 'Get-OneDriveRoot', 'Test-KnownOneDriveCloudPlaceholder', 'Assert-NoReparsePath')) {
    $functionNode = $helperAst.Find({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionNode) {
      throw "The relocation helper policy function $functionName was not found."
    }
    Invoke-Expression $functionNode.Extent.Text
  }

  $reparseAttribute = [System.IO.FileAttributes]::ReparsePoint
  $cloudDirectory = [pscustomobject]@{ Attributes = $reparseAttribute; PSIsContainer = $true; LinkType = ''; Target = $null }
  $cloudFile = [pscustomobject]@{ Attributes = $reparseAttribute; PSIsContainer = $false; LinkType = ''; Target = $null }
  $cloudTag6 = [Convert]::ToUInt32('9000601A', 16)
  $cloudTag7 = [Convert]::ToUInt32('9000701A', 16)
  $cloudTagE = [Convert]::ToUInt32('9000E01A', 16)
  $unapprovedCloudTag = [Convert]::ToUInt32('9000F01A', 16)
  $junctionTag = [Convert]::ToUInt32('A0000003', 16)

  foreach ($directoryCase in @(
    @{ Path = (Join-Path $fixtureRoot 'OneDrive'); Tag = $cloudTagE },
    @{ Path = (Join-Path $fixtureRoot 'OneDrive/Me'); Tag = $cloudTag7 },
    @{ Path = (Join-Path $repositoryRoot 'secrets'); Tag = $cloudTag6 }
  )) {
    if (-not (Test-KnownOneDriveCloudPlaceholder $directoryCase.Path $cloudDirectory $directoryCase.Tag)) {
      throw 'An observed OneDrive Cloud Files directory tag was denied.'
    }
  }

  $approvedSource = Join-Path $repositoryRoot 'secrets/local_user_password'
  if (-not (Test-KnownOneDriveCloudPlaceholder $approvedSource $cloudFile $cloudTag6)) {
    throw 'The observed OneDrive Cloud Files source-file tag was denied.'
  }
  if (Test-KnownOneDriveCloudPlaceholder (Join-Path $repositoryRoot 'unapproved') $cloudDirectory $cloudTagE) {
    throw 'An unapproved repository directory was allowed.'
  }
  if (Test-KnownOneDriveCloudPlaceholder (Join-Path $fixtureRoot 'AppData/private/credential') $cloudFile $cloudTag6) {
    throw 'An external private path was allowed.'
  }
  if (Test-KnownOneDriveCloudPlaceholder $approvedSource $cloudFile $junctionTag) {
    throw 'A junction tag was allowed.'
  }
  if (Test-KnownOneDriveCloudPlaceholder $approvedSource $cloudFile $unapprovedCloudTag) {
    throw 'An unobserved Cloud Files tag was allowed.'
  }
  $cloudFile.LinkType = 'SymbolicLink'
  if (Test-KnownOneDriveCloudPlaceholder $approvedSource $cloudFile $cloudTag6) {
    throw 'A link with LinkType metadata was allowed.'
  }

  New-Item -ItemType Junction -Path $junctionPath -Target (Join-Path $fixtureRoot 'junction-target') | Out-Null
  $actualJunctionTag = [PersonalAIWorkspace.ReparsePointTagReader]::ReadTag($junctionPath, $true)
  if ($actualJunctionTag -ne $junctionTag) {
    throw 'The synthetic junction did not report the expected mount-point tag.'
  }
  $junctionWasDenied = $false
  try {
    Assert-NoReparsePath $junctionPath
  } catch {
    $junctionWasDenied = $true
  }
  if (-not $junctionWasDenied) {
    throw 'The strict path check did not reject the synthetic junction.'
  }

  Write-Host 'Synthetic reparse policy tests passed.'
} finally {
  $fullFixtureRoot = [System.IO.Path]::GetFullPath($fixtureRoot)
  if (-not $fullFixtureRoot.StartsWith(($tempBase + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Synthetic test cleanup escaped the temporary directory.'
  }
  if (Test-Path -LiteralPath $junctionPath) {
    [System.IO.Directory]::Delete($junctionPath, $false)
  }
  if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Force -Recurse
  }
}
