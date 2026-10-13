# Nicky PC setup: join Travis's private network + let Nicky's Claude in over SSH.
# Run in an ADMIN PowerShell (Start > type PowerShell > Run as administrator), after installing Tailscale.
$ErrorActionPreference = 'Stop'
# 1. Join the private network (headscale) as nicky-pc
& "C:\Program Files\Tailscale\tailscale.exe" up --login-server https://hs.deeveeyant.com --authkey <ONE-TIME-KEY: headscale preauthkeys create -u 1 --tags tag:nicky-pc -e 4h> --hostname nicky-pc --unattended --reset
# 2. OpenSSH server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd
# 3. Only Nicky's Claude's key, admin accounts, no passwords
$k = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEFfNVJfZDuBkzn0WbEPupHuAXZR+CvF8KQ2/96P9bDi nicky-claude@nicky-dev'
$f = "$env:ProgramData\ssh\administrators_authorized_keys"
Set-Content -Path $f -Value $k -Encoding ascii
icacls $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
$c = "$env:ProgramData\ssh\sshd_config"
(Get-Content $c) -replace '^#?PasswordAuthentication .*','PasswordAuthentication no' | Set-Content $c
if (-not (Select-String -Path $c -Pattern '^PasswordAuthentication no' -Quiet)) { Add-Content $c 'PasswordAuthentication no' }
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
# 4. Firewall: SSH only from the private network, never the internet or the local Wi-Fi
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name 'OpenSSH-Tailnet' -DisplayName 'OpenSSH (private network only)' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
Restart-Service sshd
# 5. Report back
"USER=$env:USERNAME  TAILNET_IP=" + (& "C:\Program Files\Tailscale\tailscale.exe" ip -4)
