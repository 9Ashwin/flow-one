# Register one external scheduler; the CLI owns account pinning and UTC+8 deduplication.
param(
    [Parameter(Mandatory = $true)][string]$CliPath,
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$taskName = 'FlowOne-DailyCheckin-CN'
$cli = (Resolve-Path -LiteralPath $CliPath).Path
$node = (Resolve-Path -LiteralPath $NodePath).Path
$arguments = '"' + $cli + '" checkin run'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $node -or $existing.Actions[0].Arguments -ne $arguments) {
        throw 'An existing task has a different action; inspect it before replacing it.'
    }
    Enable-ScheduledTask -TaskName $taskName | Out-Null
} else {
    $action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory (Split-Path $cli)
    $periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($periodic, $logon) -Settings $settings -Principal $principal -Description 'Domestic account check-in; UTC+8 deduplication, at most three attempts per day.' | Out-Null
}
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult, NextRunTime
