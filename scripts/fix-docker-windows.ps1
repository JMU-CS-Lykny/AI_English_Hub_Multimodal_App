#Requires -RunAsAdministrator
<#
  Fix Docker Desktop on Windows for AI English Hub builds.
  Run in an elevated PowerShell (Right-click → Run as administrator):

    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\scripts\fix-docker-windows.ps1
#>

$ErrorActionPreference = "Stop"

Write-Host "==> Enabling WSL + Virtual Machine Platform features..."
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Host
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Host

Write-Host "==> Installing WSL..."
wsl --install --no-distribution
wsl --set-default-version 2

Write-Host "==> Starting Docker Desktop Service..."
Set-Service -Name com.docker.service -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service com.docker.service -ErrorAction SilentlyContinue

$dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dd) {
  Write-Host "==> Launching Docker Desktop..."
  Start-Process $dd
}

Write-Host ""
Write-Host "If this is the first WSL install, REBOOT Windows, then:"
Write-Host "  1. Open Docker Desktop and wait until it says 'Engine running'"
Write-Host "  2. cd to the project folder"
Write-Host "  3. docker compose up --build"
Write-Host ""
