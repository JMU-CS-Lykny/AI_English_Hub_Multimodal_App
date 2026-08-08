#!/usr/bin/env pwsh
# Start the stack in detached mode (no endless log spam in the terminal).
param(
  [switch]$Build,
  [switch]$Storage,
  [string[]]$Follow = @("web", "gateway")
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env from .env.example"
}

$profileArgs = @()
if ($Storage) { $profileArgs += @("--profile", "storage") }

$upArgs = @("compose") + $profileArgs + @("up", "-d")
if ($Build) { $upArgs += "--build" }

Write-Host ">> docker $($upArgs -join ' ')"
& docker @upArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Stack is up in the background."
Write-Host "  Web:     http://localhost:3000"
Write-Host "  Gateway: http://localhost:8080/swagger-ui.html"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  docker compose ps"
Write-Host "  docker compose logs -f --tail=80 $($Follow -join ' ')"
Write-Host "  docker compose down"
