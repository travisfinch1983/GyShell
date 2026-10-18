# Cheat Engine MCP relay setup (run once, in an ADMIN PowerShell, on the PC that runs Cheat Engine).
# Installs miscusi-peek/cheatengine-mcp-bridge (pinned commit), pywin32, and a firewall lockdown so
# ONLY claude1 (10.0.0.161) can reach the relay port. The relay has no auth of its own: whoever can
# connect can drive Cheat Engine (including its Lua engine), hence the firewall rules.
$ErrorActionPreference = 'Stop'
$Commit  = '6bd7ce9'
$Dir     = 'C:\cheatengine-mcp-bridge'
$Port    = 9876
$Allowed = '10.0.0.161'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an Administrator PowerShell (needed for the firewall rules).'
}

# 1. Python + pywin32
# (Windows PowerShell 5.1 compatible: no ?? operator)
$py = Get-Command py -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
if ($py -and $py.Source -like '*WindowsApps*') { $py = $null }   # the Store stub, not a real Python
if (-not $py) {
    Write-Host 'Installing Python 3.12 via winget...'
    winget install -e --id Python.Python.3.12 --scope machine --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $py = Get-Command py -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python }
}
& $py.Source -m pip install --upgrade pywin32

# 2. Bridge files at the pinned commit
$zip = Join-Path $env:TEMP 'ce-mcp-bridge.zip'
Invoke-WebRequest "https://github.com/miscusi-peek/cheatengine-mcp-bridge/archive/$Commit.zip" -OutFile $zip
$tmp = Join-Path $env:TEMP 'ce-mcp-bridge-x'; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $tmp
New-Item -ItemType Directory -Force $Dir | Out-Null
Copy-Item (Join-Path (Get-ChildItem $tmp | Select-Object -First 1).FullName '*') $Dir -Recurse -Force

# 3. Firewall: allow claude1, and BLOCK everyone else (block rules beat any broad "allow python" rule)
Get-NetFirewallRule -DisplayName 'CE MCP relay*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'CE MCP relay - allow claude1' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $Allowed -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'CE MCP relay - block others' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress '0.0.0.0-10.0.0.160','10.0.0.162-255.255.255.255' -Action Block -Profile Any | Out-Null

# 4. Launcher
$bat = @"
@echo off
title CE MCP relay (port $Port, claude1 only)
"$($py.Source)" "$Dir\MCP_Server\ce_tcp_relay.py" --host 0.0.0.0 --port $Port
pause
"@
Set-Content -Path "$Dir\start-relay.bat" -Value $bat -Encoding ASCII
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\CE MCP relay.lnk")
$lnk.TargetPath = "$Dir\start-relay.bat"; $lnk.Save()

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '10.0.0.*' } | Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "Done. This PC's LAN IP: $ip   <-- tell Claude this"
Write-Host "Each session:"
Write-Host "  1. Cheat Engine: File > Execute Script > $Dir\MCP_Server\ce_mcp_bridge.lua  (look for 'MCP Server Listening')"
Write-Host "  2. Double-click 'CE MCP relay' on the desktop and leave the window open"
