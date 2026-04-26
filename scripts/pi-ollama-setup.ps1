$ErrorActionPreference = "Stop"

$PiHost = "192.168.1.52"
$PiUser = "pi"
$Model = "llama3.2:3b"

if (-not (Get-Module -ListAvailable -Name Posh-SSH)) {
  Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force
  Install-Module -Name Posh-SSH -Scope CurrentUser -Force -AllowClobber
}

Import-Module Posh-SSH

$Password = Read-Host "Password for $PiUser@$PiHost" -AsSecureString
$Credential = [pscredential]::new($PiUser, $Password)

$Session = New-SSHSession -ComputerName $PiHost -Credential $Credential -AcceptKey
try {
  $Script = Get-Content -Raw -Path "$PSScriptRoot\pi-ollama-setup.sh"
  Set-SCPItem -ComputerName $PiHost -Credential $Credential -AcceptKey -Path "$PSScriptRoot\pi-ollama-setup.sh" -Destination "/tmp"
  Invoke-SSHCommand -SessionId $Session.SessionId -Command "chmod +x /tmp/pi-ollama-setup.sh && /tmp/pi-ollama-setup.sh $Model" -TimeOut 1800
} finally {
  Remove-SSHSession -SessionId $Session.SessionId | Out-Null
}
