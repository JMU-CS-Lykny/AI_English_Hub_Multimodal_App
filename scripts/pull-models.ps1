# Pull Ollama models without `docker compose exec`
# Use when Docker Desktop returns 500 on exec, or prefer HTTP API.

$ErrorActionPreference = "Stop"
$base = "http://localhost:11434"

Write-Host "Checking Ollama at $base ..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-RestMethod -Uri "$base/api/tags" -TimeoutSec 3 | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}

if (-not $ready) {
  Write-Host "Ollama is not reachable. Start the stack first:"
  Write-Host "  docker compose up -d ollama"
  Write-Host "If Docker returns API 500 errors, restart Docker Desktop, then retry."
  exit 1
}

foreach ($model in @("llama3.2", "nomic-embed-text")) {
  Write-Host "Pulling $model ..."
  Invoke-RestMethod -Method Post -Uri "$base/api/pull" -ContentType "application/json" `
    -Body (@{ name = $model; stream = $false } | ConvertTo-Json) -TimeoutSec 3600 | Out-Null
  Write-Host "  done: $model"
}

Write-Host "Models ready."
