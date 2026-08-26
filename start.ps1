Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host "Starting Hugo server at http://localhost:1313/ (Ctrl+C to stop)"
hugo server --port 1313 --bind 0.0.0.0 -D --minify
