param(
  [Parameter(Mandatory = $true)][string]$InstallerDir,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [int]$TimeoutSeconds = 300,
  [int]$IdleExitSeconds = 8
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$prefix = [IO.Path]::GetFullPath($InstallerDir).TrimEnd("\") + "\"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$seen = $false
$idleSince = $null
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button
)

function Write-WizardEvent([hashtable]$Data) {
  $Data["at"] = (Get-Date).ToUniversalTime().ToString("o")
  Add-Content -LiteralPath $LogPath -Value ($Data | ConvertTo-Json -Compress)
}

function Get-InstallerProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Invoke-WizardButtons([int]$ProcessId) {
  $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $ProcessId
  )
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $windowCondition
  )
  foreach ($window in $windows) {
    $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    foreach ($button in $buttons) {
      $name = $button.Current.Name -replace "&", ""
      if (-not $button.Current.IsEnabled -or $name -notmatch "^(Next|Install|Finish)") { continue }
      $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      Write-WizardEvent @{ event = "click"; pid = $ProcessId; window = $window.Current.Name; button = $name }
      $pattern.Invoke()
      return
    }
  }
}

Write-WizardEvent @{ event = "watching"; timeoutSeconds = $TimeoutSeconds }
while ((Get-Date) -lt $deadline) {
  $processes = Get-InstallerProcesses
  if ($processes.Count -gt 0) {
    if (-not $seen) { Write-WizardEvent @{ event = "installer-started"; pids = @($processes | ForEach-Object { [int]$_.ProcessId }) } }
    $seen = $true
    $idleSince = $null
    foreach ($process in $processes) {
      try { Invoke-WizardButtons ([int]$process.ProcessId) } catch { Write-WizardEvent @{ event = "ui-error"; message = $_.Exception.Message } }
    }
  } elseif ($seen) {
    if ($null -eq $idleSince) { $idleSince = Get-Date }
    elseif (((Get-Date) - $idleSince).TotalSeconds -ge $IdleExitSeconds) {
      Write-WizardEvent @{ event = "installer-exited" }
      exit 0
    }
  }
  Start-Sleep -Milliseconds 750
}
Write-WizardEvent @{ event = "timeout"; installerSeen = $seen }
exit 0
