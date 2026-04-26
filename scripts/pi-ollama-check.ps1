$ErrorActionPreference = "Stop"

$BaseUrl = $env:OLLAMA_BASE_URL
if (-not $BaseUrl) {
  $BaseUrl = "http://192.168.1.52:11434"
}

Write-Host "Checking Ollama at $BaseUrl ..."
$tags = Invoke-RestMethod -Uri "$BaseUrl/api/tags" -Method Get -TimeoutSec 10
$tags | ConvertTo-Json -Depth 8
