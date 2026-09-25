#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$ExpectedPublisher = "",
  [switch]$AllowUnsigned,
  [switch]$AppOnly,
  [string]$OutFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PeExtensions = @(".exe", ".dll", ".node")
$FirstPartyAppFiles = @("win-unpacked/cw-code.exe")
$AcceptedThirdPartyStatuses = @("NotSigned", "Valid")

function ConvertFrom-DistinguishedName([string]$Sequence) {
  $seq = $Sequence.Trim()
  $result = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
  $quoted = $false
  $key = $null
  $token = ""
  $nextNonSpace = 0
  for ($i = 0; $i -le $seq.Length; $i++) {
    if ($i -eq $seq.Length) {
      if ($null -ne $key) { $result[$key] = $token }
      break
    }
    $ch = $seq[$i]
    if ($quoted) {
      if ($ch -eq '"') { $quoted = $false; continue }
    } else {
      if ($ch -eq '"') { $quoted = $true; continue }
      if ($ch -eq '\') {
        $i++
        $slice = if ($i -lt $seq.Length) { $seq.Substring($i, [Math]::Min(2, $seq.Length - $i)) } else { "" }
        $hexPrefix = [regex]::Match($slice, '^[0-9A-Fa-f]+').Value
        if ($hexPrefix.Length -gt 0) {
          $i++
          $token += [char][Convert]::ToInt32($hexPrefix, 16)
        } elseif ($i -lt $seq.Length) {
          $token += $seq[$i]
        }
        continue
      }
      if ($null -eq $key -and $ch -eq '=') { $key = $token; $token = ""; continue }
      if ($ch -eq ',' -or $ch -eq ';' -or $ch -eq '+') {
        if ($null -ne $key) { $result[$key] = $token }
        $key = $null
        $token = ""
        continue
      }
    }
    if ($ch -eq ' ' -and -not $quoted) {
      if ($token.Length -eq 0) { continue }
      if ($i -gt $nextNonSpace) {
        $j = $i
        while ($j -lt $seq.Length -and $seq[$j] -eq ' ') { $j++ }
        $nextNonSpace = $j
      }
      $next = if ($nextNonSpace -lt $seq.Length) { $seq[$nextNonSpace] } else { $null }
      if ($null -eq $next -or $next -eq ',' -or $next -eq ';' -or ($null -eq $key -and $next -eq '=') -or ($null -ne $key -and $next -eq '+')) {
        $i = $nextNonSpace - 1
        continue
      }
    }
    $token += $ch
  }
  return $result
}

function Test-PublisherMatch([string]$Subject, [string]$Expected) {
  if ([string]::IsNullOrEmpty($Subject) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
  $actual = ConvertFrom-DistinguishedName $Subject
  $wanted = ConvertFrom-DistinguishedName $Expected
  if ($wanted.Count -gt 0) {
    foreach ($entry in $wanted.GetEnumerator()) {
      if (-not $actual.ContainsKey($entry.Key) -or $actual[$entry.Key] -cne $entry.Value) { return $false }
    }
    return $true
  }
  return $actual.ContainsKey("CN") -and $actual["CN"] -ceq $Expected
}

function Get-Sha512Base64([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::HashData($stream))
  } finally {
    $stream.Dispose()
  }
}

function Test-File([System.IO.FileInfo]$File, [string]$RootPath, [string]$Role) {
  $relative = [System.IO.Path]::GetRelativePath($RootPath, $File.FullName).Replace("\", "/")
  $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  $status = $signature.Status.ToString()
  $subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
  $timestamped = $null -ne $signature.TimeStamperCertificate
  $publisherOk = Test-PublisherMatch $subject $ExpectedPublisher
  $errors = [System.Collections.Generic.List[string]]::new()
  if ($Role -eq "first-party" -and -not $AllowUnsigned) {
    if ($status -ne "Valid") { $errors.Add("first-party Authenticode status is ${status}: $($signature.StatusMessage)") }
    if (-not $timestamped) { $errors.Add("first-party file has no timestamp countersignature") }
    if (-not $publisherOk) { $errors.Add("first-party signer '$subject' does not match expected publisher '$ExpectedPublisher'") }
  } elseif ($AcceptedThirdPartyStatuses -notcontains $status) {
    $errors.Add("Authenticode status is ${status} (only NotSigned or Valid accepted): $($signature.StatusMessage)")
  }
  return [ordered]@{
    path             = $relative
    role             = $Role
    sha512           = Get-Sha512Base64 $File.FullName
    status           = $status
    signed           = $status -eq "Valid"
    subject          = $subject
    publisherMatches = $publisherOk
    timestamped      = $timestamped
    errors           = $errors
  }
}

$structuralErrors = [System.Collections.Generic.List[string]]::new()
$files = [System.Collections.Generic.List[object]]::new()
$rootPath = $null

if ([string]::IsNullOrWhiteSpace($ExpectedPublisher) -and -not $AllowUnsigned) {
  $structuralErrors.Add("-ExpectedPublisher is required unless -AllowUnsigned is set")
}

if (Test-Path -LiteralPath $Root -PathType Container) {
  $rootPath = (Resolve-Path -LiteralPath $Root).Path
  $unpacked = Join-Path $rootPath "win-unpacked"
  $installers = @()
  if (-not $AppOnly) {
    $installers = @(Get-ChildItem -LiteralPath $rootPath -File -Filter "*.exe")
    if ($installers.Count -ne 1) {
      $structuralErrors.Add("expected exactly one installer .exe directly under $rootPath, found $($installers.Count)")
    }
  }
  $peFiles = @()
  if (Test-Path -LiteralPath $unpacked -PathType Container) {
    $peFiles = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File | Where-Object { $PeExtensions -contains $_.Extension.ToLowerInvariant() } | Sort-Object FullName)
    foreach ($required in $FirstPartyAppFiles) {
      if (-not (Test-Path -LiteralPath (Join-Path $rootPath $required) -PathType Leaf)) {
        $structuralErrors.Add("first-party file $required not found under $rootPath")
      }
    }
  } else {
    $structuralErrors.Add("win-unpacked directory not found under $rootPath")
  }
  foreach ($file in $peFiles) {
    $relative = [System.IO.Path]::GetRelativePath($rootPath, $file.FullName).Replace("\", "/")
    $role = if ($FirstPartyAppFiles -ccontains $relative) { "first-party" } else { "third-party" }
    $files.Add((Test-File $file $rootPath $role))
  }
  foreach ($file in $installers) {
    $files.Add((Test-File $file $rootPath "first-party"))
  }
} else {
  $structuralErrors.Add("root directory not found: $Root")
}

$failedFiles = @($files | Where-Object { $_.errors.Count -gt 0 }).Count
$ok = $structuralErrors.Count -eq 0 -and $failedFiles -eq 0

$report = [ordered]@{
  root              = $rootPath
  expectedPublisher = if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { $null } else { $ExpectedPublisher }
  allowUnsigned     = [bool]$AllowUnsigned
  appOnly           = [bool]$AppOnly
  ok                = $ok
  checkedAt         = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [System.Globalization.CultureInfo]::InvariantCulture)
  summary           = [ordered]@{ total = $files.Count; failed = $failedFiles }
  errors            = $structuralErrors
  files             = $files
}

$json = $report | ConvertTo-Json -Depth 6
if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
  $outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
  [System.IO.File]::WriteAllText($outPath, $json + "`n", [System.Text.UTF8Encoding]::new($false))
}
Write-Output $json

if (-not $ok) { exit 1 }
exit 0
