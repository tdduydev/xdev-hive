#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Prepares Windows Server 2022 to run the xDev Hive hub in a small Linux VM under Hyper-V (docs/deployment/windows-server-2022.md).

.DESCRIPTION
  Podman's Windows build (podman machine on WSL2 or Hyper-V) is documented for Windows 11, not Windows Server, so the
  hub's Linux container runs under Podman inside a Hyper-V guest instead. This script, run once on the host:
    - creates an internal switch with a NAT network for the VM (outbound to ghcr.io; nothing inbound but the hub port)
    - creates a Generation 2 VM with Secure Boot for Linux, an OS disk and a separate data disk, booting the ISO
    - starts the VM with the host and shuts it down cleanly with it
    - forwards <host>:7788 to the VM and opens 7788 in Windows Firewall to the given networks only
  It is safe to run again: what exists is left as it is. Install the OS in the VM afterwards (AlmaLinux 9 minimal or
  RHEL 9) with the static address below, then deploy/podman/install.sh inside it.

.EXAMPLE
  .\New-HiveHost.ps1 -IsoPath D:\ISO\AlmaLinux-9-latest-x86_64-minimal.iso -AllowedRemote 10.0.0.0/16,10.8.0.0/24
#>
param(
  [Parameter(Mandatory)] [string] $IsoPath,
  [string] $VmName = "xdev-hive",
  [string] $VmRoot = "D:\Hyper-V\xdev-hive",
  [int] $Cpu = 4,
  [int64] $MemoryGB = 8,
  [int64] $OsDiskGB = 40,
  [int64] $DataDiskGB = 100,
  [string] $SwitchName = "xdev-hive-nat",
  [string] $NatName = "xdev-hive-nat",
  [string] $NatPrefix = "192.168.250",
  [string] $VmIp = "192.168.250.10",
  [int] $HubPort = 7788,
  # Who may open the hub: the corporate LAN and VPN ranges. Never Any.
  [Parameter(Mandatory)] [string[]] $AllowedRemote
)
$ErrorActionPreference = "Stop"

if ((Get-WindowsFeature -Name Hyper-V).InstallState -ne "Installed") {
  throw "Hyper-V is not installed. Run: Install-WindowsFeature -Name Hyper-V -IncludeManagementTools -Restart  (then this script again)"
}
if ($AllowedRemote -contains "Any" -or $AllowedRemote -contains "0.0.0.0/0") { throw "AllowedRemote must list the LAN/VPN ranges, not Any." }

# Internal switch + NAT: the VM gets 192.168.250.10, the host 192.168.250.1, and the VM reaches out through the host.
if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
  New-VMSwitch -Name $SwitchName -SwitchType Internal | Out-Null
}
$ifIndex = (Get-NetAdapter -Name "vEthernet ($SwitchName)").ifIndex
if (-not (Get-NetIPAddress -InterfaceIndex $ifIndex -IPAddress "$NatPrefix.1" -ErrorAction SilentlyContinue)) {
  New-NetIPAddress -InterfaceIndex $ifIndex -IPAddress "$NatPrefix.1" -PrefixLength 24 | Out-Null
}
if (-not (Get-NetNat -Name $NatName -ErrorAction SilentlyContinue)) {
  # Windows allows one NAT network per host: another one (Docker, an older lab) has to go first.
  if (Get-NetNat) { throw "Another NetNat exists ($((Get-NetNat).Name -join ', ')); Windows supports one. Remove or reuse it." }
  New-NetNat -Name $NatName -InternalIPInterfaceAddressPrefix "$NatPrefix.0/24" | Out-Null
}

# The VM: Gen 2, Secure Boot with the template Linux distributions are signed for.
if (-not (Get-VM -Name $VmName -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force -Path $VmRoot | Out-Null
  $os = Join-Path $VmRoot "os.vhdx"
  $data = Join-Path $VmRoot "data.vhdx"
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) -Path $VmRoot -NewVHDPath $os -NewVHDSizeBytes ($OsDiskGB * 1GB) -SwitchName $SwitchName | Out-Null
  Set-VM -Name $VmName -ProcessorCount $Cpu -StaticMemory -AutomaticCheckpointsEnabled $false -CheckpointType Production
  Set-VMFirmware -VMName $VmName -SecureBootTemplate MicrosoftUEFICertificateAuthority
  # /srv/hive lives on its own disk: the OS can be reinstalled without touching the hub's data.
  New-VHD -Path $data -SizeBytes ($DataDiskGB * 1GB) -Dynamic | Out-Null
  Add-VMHardDiskDrive -VMName $VmName -Path $data
  Add-VMDvdDrive -VMName $VmName -Path $IsoPath
  $dvd = Get-VMDvdDrive -VMName $VmName
  Set-VMFirmware -VMName $VmName -FirstBootDevice $dvd
}
# With the host: start after a reboot (after a short delay), shut down cleanly so SQLite closes.
Set-VM -Name $VmName -AutomaticStartAction Start -AutomaticStartDelay 30 -AutomaticStopAction ShutDown
Enable-VMIntegrationService -VMName $VmName -Name "Shutdown", "Heartbeat", "Time Synchronization"

# <host>:7788 → VM:7788. Static mappings are part of WinNAT; no proxy process to keep alive.
if (-not (Get-NetNatStaticMapping -NatName $NatName -ErrorAction SilentlyContinue | Where-Object { $_.ExternalPort -eq $HubPort })) {
  Add-NetNatStaticMapping -NatName $NatName -Protocol TCP -ExternalIPAddress 0.0.0.0 -ExternalPort $HubPort -InternalIPAddress $VmIp -InternalPort $HubPort | Out-Null
}
$rule = "xDev Hive hub $HubPort"
if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName $rule }
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $HubPort -RemoteAddress $AllowedRemote -Action Allow -Profile Domain, Private | Out-Null

Write-Host "VM $VmName ready on switch $SwitchName. Install the OS with address $VmIp/24, gateway $NatPrefix.1, then deploy/podman/install.sh."
Write-Host "Hub will answer on http://<this host>:$HubPort once deployed; allowed from: $($AllowedRemote -join ', ')."
