#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$ExpectedPublisher = "",
  [switch]$AllowUnsigned,
  [string]$OutFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PeExtensions = @(".exe", ".dll", ".node")

function ConvertFrom-DistinguishedName([string]$Dn) {
  $result = @{}
  $parts = [System.Collections.Generic.List[string]]::new()
  $current = [System.Text.StringBuilder]::new()
  $quoted = $false
  foreach ($char in $Dn.ToCharArray()) {
    if ($char -eq '"') { $quoted = -not $quoted }
    if (($char -eq ',' -or $char -eq ';') -and -not $quoted) {
      $parts.Add($current.ToString())
      [void]$current.Clear()
      continue
    }
    [void]$current.Append($char)
  }
  $parts.Add($current.ToString())
  foreach ($part in $parts) {
    $separator = $part.IndexOf("=")
    if ($separator -le 0) { continue }
    $key = $part.Substring(0, $separator).Trim().ToUpperInvariant()
    $value = $part.Substring($separator + 1).Trim() -replace '^"(.*)"$', '$1'
    if (-not $result.ContainsKey($key)) { $result[$key] = $value }
  }
  return $result
}

function Test-PublisherMatch([string]$Subject, [string]$Expected) {
  if ([string]::IsNullOrEmpty($Subject) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
  $actual = ConvertFrom-DistinguishedName $Subject
  if (-not $Expected.Contains("=")) { return $actual["CN"] -ceq $Expected }
  $wanted = ConvertFrom-DistinguishedName $Expected
  if ($wanted.Count -eq 0) { return $false }
  foreach ($key in $wanted.Keys) {
    if ($actual[$key] -cne $wanted[$key]) { return $false }
  }
  return $true
}

function Get-Sha512Base64([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::HashData($stream))
  } finally {
    $stream.Dispose()
  }
}

function Test-File([System.IO.FileInfo]$File, [string]$RootPath) {
  $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  $status = $signature.Status.ToString()
  $subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
  $timestamped = $null -ne $signature.TimeStamperCertificate
  $publisherOk = Test-PublisherMatch $subject $ExpectedPublisher
  $errors = [System.Collections.Generic.List[string]]::new()
  if ($status -ne "Valid") { $errors.Add("Authenticode status is ${status}: $($signature.StatusMessage)") }
  if (-not $timestamped) { $errors.Add("no trusted timestamp") }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisher) -and -not $publisherOk) {
    $errors.Add("signer '$subject' does not match expected publisher '$ExpectedPublisher'")
  }
  return [ordered]@{
    path             = [System.IO.Path]::GetRelativePath($RootPath, $File.FullName).Replace("\", "/")
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
  $installers = @(Get-ChildItem -LiteralPath $rootPath -File -Filter "*.exe")
  if ($installers.Count -ne 1) {
    $structuralErrors.Add("expected exactly one installer .exe directly under $rootPath, found $($installers.Count)")
  }
  $peFiles = @()
  if (Test-Path -LiteralPath $unpacked -PathType Container) {
    $peFiles = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File | Where-Object { $PeExtensions -contains $_.Extension.ToLowerInvariant() } | Sort-Object FullName)
    if ($peFiles.Count -eq 0) { $structuralErrors.Add("no PE files (.exe, .dll, .node) found under $unpacked") }
  } else {
    $structuralErrors.Add("win-unpacked directory not found under $rootPath")
  }
  foreach ($file in @($peFiles) + @($installers)) {
    $files.Add((Test-File $file $rootPath))
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

if ($structuralErrors.Count -gt 0) { exit 1 }
if (-not $ok -and -not $AllowUnsigned) { exit 1 }
exit 0
