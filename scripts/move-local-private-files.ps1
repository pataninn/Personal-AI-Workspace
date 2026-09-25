[CmdletBinding()]
param(
  [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$markerPath = Join-Path $repositoryRoot '.personal-ai-workspace-identity'
$sourceEnvironment = Join-Path $repositoryRoot '.env'
$sourceLocalPassword = Join-Path $repositoryRoot 'secrets/local_user_password'
$sourceProviderKey = Join-Path $repositoryRoot 'secrets/nvidia_api_key'
$sourceTlsCertificate = Join-Path $repositoryRoot 'docker/certs/tls.crt'
$sourceTlsKey = Join-Path $repositoryRoot 'docker/certs/tls.key'
$repositoryCloudFilePaths = @(
  $sourceEnvironment,
  $sourceLocalPassword,
  $sourceProviderKey,
  $sourceTlsCertificate,
  $sourceTlsKey,
  $markerPath
)

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is required to locate the private configuration directory.'
}

$localAppData = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
$privateRoot = Join-Path $localAppData 'Personal-AI-Workspace/private'
$privateEnvironment = Join-Path $privateRoot '.env'
$privateLocalPassword = Join-Path $privateRoot 'secrets/local_user_password'
$privateProviderKey = Join-Path $privateRoot 'secrets/nvidia_api_key'
$privateTlsCertificate = Join-Path $privateRoot 'tls/tls.crt'
$privateTlsKey = Join-Path $privateRoot 'tls/tls.key'
$rollbackRoot = Join-Path $privateRoot 'rollback/before-direct-workspace'
$rollbackEnvironment = Join-Path $rollbackRoot '.env'

if (-not ('PersonalAIWorkspace.ReparsePointTagReader' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace PersonalAIWorkspace {
  public static class ReparsePointTagReader {
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint FsctlGetReparsePoint = 0x000900A8;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateFileW", SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
      string fileName,
      uint desiredAccess,
      uint shareMode,
      IntPtr securityAttributes,
      uint creationDisposition,
      uint flagsAndAttributes,
      IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
      SafeFileHandle device,
      uint controlCode,
      IntPtr inputBuffer,
      uint inputBufferSize,
      [Out] byte[] outputBuffer,
      uint outputBufferSize,
      out uint bytesReturned,
      IntPtr overlapped);

    public static uint ReadTag(string path, bool isDirectory) {
      uint flags = OpenReparsePoint | (isDirectory ? BackupSemantics : 0);
      using (SafeFileHandle handle = CreateFile(
        path,
        FileReadAttributes,
        FileShareRead | FileShareWrite | FileShareDelete,
        IntPtr.Zero,
        OpenExisting,
        flags,
        IntPtr.Zero)) {
        if (handle.IsInvalid) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        byte[] buffer = new byte[16 * 1024];
        uint bytesReturned;
        if (!DeviceIoControl(handle, FsctlGetReparsePoint, IntPtr.Zero, 0, buffer, (uint)buffer.Length, out bytesReturned, IntPtr.Zero)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (bytesReturned < 4) {
          throw new IOException("The reparse-point response did not contain a tag.");
        }
        return BitConverter.ToUInt32(buffer, 0);
      }
    }
  }
}
'@ -ErrorAction Stop | Out-Null
}

function Test-PathInside([string]$Root, [string]$Candidate) {
  $separatorCharacters = [char[]]@('\', '/')
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd($separatorCharacters)
  $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
  if ([string]::Equals($rootPath, $candidatePath.TrimEnd($separatorCharacters), [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  return $candidatePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-OneDriveRoot {
  foreach ($candidate in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    $candidateRoot = [System.IO.Path]::GetFullPath($candidate)
    if (([string]::Equals($candidateRoot.TrimEnd([char[]]@('\', '/')), $repositoryRoot.TrimEnd([char[]]@('\', '/')), [System.StringComparison]::OrdinalIgnoreCase)) -or
      (Test-PathInside $candidateRoot $repositoryRoot)) {
      return $candidateRoot
    }
  }

  $currentPath = $repositoryRoot
  while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    $leafName = [System.IO.Path]::GetFileName($currentPath.TrimEnd([char[]]@('\', '/')))
    if ($leafName -match '^OneDrive(?:\s+-\s+.+)?$') {
      return $currentPath
    }
    $parentPath = [System.IO.Directory]::GetParent($currentPath)
    if ($null -eq $parentPath) {
      break
    }
    $currentPath = $parentPath.FullName
  }
  return $null
}

function Test-KnownOneDriveCloudPlaceholder([string]$Path, [object]$Item, [uint32]$ReparseTag) {
  $linkTypeProperty = $Item.PSObject.Properties['LinkType']
  $targetProperty = $Item.PSObject.Properties['Target']
  if (($null -ne $linkTypeProperty -and -not [string]::IsNullOrWhiteSpace([string]$linkTypeProperty.Value)) -or
    ($null -ne $targetProperty -and -not [string]::IsNullOrWhiteSpace([string]$targetProperty.Value))) {
    return $false
  }

  $oneDriveRoot = Get-OneDriveRoot
  if ([string]::IsNullOrWhiteSpace($oneDriveRoot)) {
    return $false
  }
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $oneDrivePath = [System.IO.Path]::GetFullPath($oneDriveRoot)
  $isInsideOneDrive = [string]::Equals($fullPath.TrimEnd([char[]]@('\', '/')), $oneDrivePath.TrimEnd([char[]]@('\', '/')), [System.StringComparison]::OrdinalIgnoreCase) -or
    (Test-PathInside $oneDrivePath $fullPath)
  if (-not $isInsideOneDrive) {
    return $false
  }

  $repositoryRootPath = $repositoryRoot.TrimEnd([char[]]@('\', '/'))
  if ($Item.PSIsContainer) {
    $isRepositoryAncestor = [string]::Equals($fullPath.TrimEnd([char[]]@('\', '/')), $repositoryRootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      (Test-PathInside $fullPath $repositoryRootPath)
    if (-not $isRepositoryAncestor) {
      foreach ($sourcePath in $repositoryCloudFilePaths) {
        $sourceDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($sourcePath))
        if ([string]::Equals($fullPath.TrimEnd([char[]]@('\', '/')), $sourceDirectory.TrimEnd([char[]]@('\', '/')), [System.StringComparison]::OrdinalIgnoreCase) -or
          (Test-PathInside $fullPath $sourceDirectory)) {
          $isRepositoryAncestor = $true
          break
        }
      }
    }
    # These exact directory tags were observed on the approved OneDrive tree.
    $knownCloudDirectoryTags = @(
      [Convert]::ToUInt32('9000601A', 16),
      [Convert]::ToUInt32('9000701A', 16),
      [Convert]::ToUInt32('9000E01A', 16)
    )
    return $isRepositoryAncestor -and ($knownCloudDirectoryTags -contains $ReparseTag)
  }

  $isApprovedSource = $repositoryCloudFilePaths | Where-Object {
    [string]::Equals([System.IO.Path]::GetFullPath($_), $fullPath, [System.StringComparison]::OrdinalIgnoreCase)
  } | Select-Object -First 1
  $cloudFileTag = [Convert]::ToUInt32('9000601A', 16)
  return ($null -ne $isApprovedSource) -and (Test-PathInside $repositoryRoot $fullPath) -and ($ReparseTag -eq $cloudFileTag)
}

function Assert-NoReparsePath([string]$Path, [switch]$AllowRepositoryCloudPlaceholders) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $volumeRoot = [System.IO.Path]::GetPathRoot($fullPath)
  $currentPath = $volumeRoot
  $segments = $fullPath.Substring($volumeRoot.Length).Split([System.IO.Path]::DirectorySeparatorChar)
  foreach ($segment in $segments) {
    if ($segment.Length -eq 0) {
      continue
    }
    $currentPath = Join-Path $currentPath $segment
    if (Test-Path -LiteralPath $currentPath) {
      $item = Get-Item -LiteralPath $currentPath -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        $isAllowedCloudPlaceholder = $false
        if ($AllowRepositoryCloudPlaceholders) {
          try {
            $tag = [PersonalAIWorkspace.ReparsePointTagReader]::ReadTag($currentPath, [bool]$item.PSIsContainer)
            $isAllowedCloudPlaceholder = Test-KnownOneDriveCloudPlaceholder $currentPath $item $tag
          } catch {
            $isAllowedCloudPlaceholder = $false
          }
        }
        if (-not $isAllowedCloudPlaceholder) {
          throw 'A configured path contains an unapproved reparse point. No files were moved.'
        }
      }
    }
  }
}

function Assert-RegularFile([string]$Path, [string]$Description, [switch]$AllowRepositoryCloudPlaceholder) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The required $Description file is missing. No files were moved."
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    $isAllowedCloudPlaceholder = $false
    if ($AllowRepositoryCloudPlaceholder) {
      try {
        $tag = [PersonalAIWorkspace.ReparsePointTagReader]::ReadTag($Path, [bool]$item.PSIsContainer)
        $isAllowedCloudPlaceholder = Test-KnownOneDriveCloudPlaceholder $Path $item $tag
      } catch {
        $isAllowedCloudPlaceholder = $false
      }
    }
    if (-not $isAllowedCloudPlaceholder) {
      throw "The $Description file contains an unapproved reparse point. No files were moved."
    }
  }
}

function Assert-PrivateLocation {
  if (-not (Test-PathInside $localAppData ([System.IO.Path]::GetFullPath($privateRoot)))) {
    throw 'The private configuration directory must remain under LOCALAPPDATA.'
  }
  if (Test-PathInside $repositoryRoot ([System.IO.Path]::GetFullPath($privateRoot))) {
    throw 'The private configuration directory cannot be inside the application repository.'
  }
  Assert-NoReparsePath $repositoryRoot -AllowRepositoryCloudPlaceholders
  Assert-NoReparsePath $localAppData
  Assert-NoReparsePath $privateRoot
}

function Get-SourceFiles {
  return @(
    [pscustomobject]@{ Source = $sourceEnvironment; Destination = $privateEnvironment; Description = 'environment configuration' },
    [pscustomobject]@{ Source = $sourceLocalPassword; Destination = $privateLocalPassword; Description = 'local login password' },
    [pscustomobject]@{ Source = $sourceProviderKey; Destination = $privateProviderKey; Description = 'provider credential' },
    [pscustomobject]@{ Source = $sourceTlsCertificate; Destination = $privateTlsCertificate; Description = 'TLS certificate' },
    [pscustomobject]@{ Source = $sourceTlsKey; Destination = $privateTlsKey; Description = 'TLS private key' }
  )
}

function Get-FileHashValue([string]$Path) {
  $hashResult = Get-FileHash -LiteralPath $Path -Algorithm SHA256
  return $hashResult.Hash
}

function Copy-VerifiedFile([string]$Source, [string]$Destination) {
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Destination)) | Out-Null
  [System.IO.File]::Copy($Source, $Destination, $false)
  $sourceHash = Get-FileHashValue $Source
  $destinationHash = Get-FileHashValue $Destination
  if (-not [string]::Equals($sourceHash, $destinationHash, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'A private file copy could not be verified. The original files were retained.'
  }
}

function Set-ComposeEnvValue([string]$Contents, [string]$Key, [string]$Value) {
  if ($Value.Contains("'") -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw 'A configured path cannot be represented safely in the Compose environment file.'
  }
  $pattern = '(?m)^(?<prefix>[ \t]*(?:export[ \t]+)?' + [regex]::Escape($Key) + '[ \t]*=)[^\r\n]*$'
  $matches = [regex]::Matches($Contents, $pattern)
  if ($matches.Count -gt 1) {
    throw "The Compose environment file contains multiple $Key settings. No files were moved."
  }
  $quotedValue = "'" + $Value + "'"
  if ($matches.Count -eq 1) {
    $replaceLine = {
      param($match)
      return $match.Groups['prefix'].Value + $quotedValue
    }.GetNewClosure()
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator]$replaceLine
    return [regex]::Replace($Contents, $pattern, $evaluator, [System.Text.RegularExpressions.RegexOptions]::Multiline)
  }
  $separator = if ($Contents.Contains("`r`n")) { "`r`n" } elseif ($Contents.Contains("`r")) { "`r" } else { "`n" }
  $prefix = if ($Contents.Length -eq 0 -or $Contents.EndsWith("`n") -or $Contents.EndsWith("`r")) { '' } else { $separator }
  $suffix = if ($Contents.EndsWith("`n") -or $Contents.EndsWith("`r")) { $separator } else { '' }
  return $Contents + $prefix + $Key + '=' + $quotedValue + $suffix
}

function Set-PrivateAcl([string]$Path) {
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $grant = "*${userSid}:(OI)(CI)F"
  & icacls.exe $Path '/reset' '/T' '/C' *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not reset existing access rules on the private-file directory.'
  }
  & icacls.exe $Path '/grant:r' $grant '/T' '/C' *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not grant private-file access to the current Windows user.'
  }
  & icacls.exe $Path '/inheritance:r' '/T' '/C' *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not remove other inherited access rules from the private-file directory.'
  }
  $directFileGrant = "*${userSid}:F"
  foreach ($file in Get-ChildItem -LiteralPath $Path -File -Force -Recurse) {
    & icacls.exe $file.FullName '/grant:r' $directFileGrant '/C' *> $null
    if ($LASTEXITCODE -ne 0) {
      throw 'Could not grant private-file access to the current Windows user.'
    }
  }
}

function Assert-DirectRunPrivatePaths([System.Collections.IDictionary]$EnvironmentValues) {
  foreach ($key in @('LOCAL_USER_PASSWORD_FILE', 'NVIDIA_API_KEY_FILE', 'TLS_CERT_DIR')) {
    $value = [string]$EnvironmentValues[$key]
    if (-not [System.IO.Path]::IsPathRooted($value)) {
      throw "The direct-run $key setting must be an absolute private path. No files were moved."
    }
    $fullValue = [System.IO.Path]::GetFullPath($value)
    $privateRootPath = [System.IO.Path]::GetFullPath($privateRoot)
    if (-not (Test-PathInside $privateRootPath $fullValue) -or (Test-PathInside $repositoryRoot $fullValue)) {
      throw "The direct-run $key setting must remain outside the repository under the private directory. No files were moved."
    }
  }
}

Assert-PrivateLocation
$sourceFiles = Get-SourceFiles
foreach ($file in $sourceFiles) {
  Assert-NoReparsePath $file.Source -AllowRepositoryCloudPlaceholders
  Assert-NoReparsePath $file.Destination
}
Assert-NoReparsePath $rollbackRoot

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'compose.yaml') -PathType Leaf) -or
  -not (Test-Path -LiteralPath (Join-Path $repositoryRoot '.git') )) {
  throw 'Run this helper from the Personal-AI-Workspace application repository.'
}

foreach ($file in $sourceFiles) {
  Assert-RegularFile $file.Source $file.Description -AllowRepositoryCloudPlaceholder
}
if (Test-Path -LiteralPath $markerPath) {
  Assert-RegularFile $markerPath 'workspace identity marker' -AllowRepositoryCloudPlaceholder
}

if (Test-Path -LiteralPath $privateRoot) {
  $privateItem = Get-Item -LiteralPath $privateRoot -Force
  if (-not $privateItem.PSIsContainer -or ($privateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The private configuration path must be a normal directory.'
  }
  if (@(Get-ChildItem -LiteralPath $privateRoot -Force).Count -gt 0) {
    throw 'The private configuration directory must be empty before this one-time relocation.'
  }
}

if ($Preflight) {
  foreach ($file in $sourceFiles) {
    if (Test-Path -LiteralPath $file.Destination) {
      throw 'A private destination already exists. Review it before moving any local files.'
    }
  }
  if (Test-Path -LiteralPath $rollbackRoot) {
    throw 'A prior relocation backup already exists. Review it before moving any local files.'
  }
  Write-Host 'Preflight passed. No file contents were read or changed.'
  exit 0
}

foreach ($file in $sourceFiles) {
  if (Test-Path -LiteralPath $file.Destination) {
    throw 'A private destination already exists. Run preflight and review it before continuing.'
  }
}
if (Test-Path -LiteralPath $rollbackRoot) {
  throw 'A prior relocation backup already exists. Review it before continuing.'
}

[System.IO.Directory]::CreateDirectory((Join-Path $privateRoot 'secrets')) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $privateRoot 'tls')) | Out-Null
[System.IO.Directory]::CreateDirectory($rollbackRoot) | Out-Null
Set-PrivateAcl $privateRoot

try {
  Copy-VerifiedFile $sourceEnvironment $rollbackEnvironment
  $identity = if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    [System.IO.File]::ReadAllText($markerPath).Trim()
  } else {
    [guid]::NewGuid().ToString('D')
  }
  if ([string]::IsNullOrWhiteSpace($identity)) {
    throw 'The workspace identity marker is empty. No local files were removed.'
  }
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    [System.IO.File]::WriteAllText($markerPath, $identity, [System.Text.UTF8Encoding]::new($false))
  }

  $updatedEnvironment = [System.IO.File]::ReadAllText($sourceEnvironment)
  $environmentValues = [ordered]@{
    WORKSPACE_HOST_ROOT = $repositoryRoot
    WORKSPACE_IDENTITY_FILE = '/workspace/.personal-ai-workspace-identity'
    WORKSPACE_IDENTITY = $identity
    LOCAL_USER_PASSWORD_FILE = $privateLocalPassword
    NVIDIA_API_KEY_FILE = $privateProviderKey
    TLS_CERT_DIR = (Join-Path $privateRoot 'tls')
    POSTGRES_VOLUME_NAME = 'pai_mvp2_pg_data'
    RECOVERY_VOLUME_NAME = 'pai_mvp2_recovery'
  }
  Assert-DirectRunPrivatePaths $environmentValues
  foreach ($key in $environmentValues.Keys) {
    $updatedEnvironment = Set-ComposeEnvValue $updatedEnvironment $key ([string]$environmentValues[$key])
  }

  [System.IO.File]::WriteAllText($privateEnvironment, $updatedEnvironment, [System.Text.UTF8Encoding]::new($false))
  foreach ($file in $sourceFiles | Select-Object -Skip 1) {
    Copy-VerifiedFile $file.Source $file.Destination
  }
  Set-PrivateAcl $privateRoot

  foreach ($file in $sourceFiles) {
    if (-not (Test-Path -LiteralPath $file.Destination -PathType Leaf)) {
      throw 'A required private copy is missing. Original files were retained.'
    }
    $destinationHash = Get-FileHashValue $file.Destination
    if ($file.Source -ne $sourceEnvironment) {
      $sourceHash = Get-FileHashValue $file.Source
      if (-not [string]::Equals($sourceHash, $destinationHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'A private copy changed before verification. Original files were retained.'
      }
    }
  }

  foreach ($file in $sourceFiles) {
    Remove-Item -LiteralPath $file.Source -Force
  }
  foreach ($source in @($sourceEnvironment, $sourceLocalPassword, $sourceProviderKey, $sourceTlsCertificate, $sourceTlsKey)) {
    if (Test-Path -LiteralPath $source) {
      throw 'A local private file could not be removed. Keep Compose stopped until the repository has been checked.'
    }
  }
} catch {
  Write-Host 'Relocation did not complete. Some repository source files may already have been removed; verified copies remain in the private directory, and partial copies may also be present. Keep Compose stopped and review both locations before retrying.'
  throw
}

Write-Host 'Private files were copied, verified, and moved outside the application repository. The identity marker is ready for the direct workspace mount.'
Write-Host 'The original environment file was retained in the private rollback folder. Do not print or commit any private file.'
