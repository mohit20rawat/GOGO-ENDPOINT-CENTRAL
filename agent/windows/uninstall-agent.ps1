# Remove the per-user GOGO Endpoint Central auto-start task.
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$taskName = "GOGO Endpoint Central Agent"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Task '$taskName' is not installed."
  exit 0
}
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed task '$taskName'."
Write-Host "The agent token and saved server URL were left untouched. Remove them separately only if you intend to offboard this device."
