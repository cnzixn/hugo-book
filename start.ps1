# Hugo 一键启动脚本
# 修改下面两行可自定义端口和主机地址
$Port = 1313
$HostAddr = "127.0.0.1"

# 刷新 PATH 以加载 winget 安装的 Hugo
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# 自动释放被占用的端口
$pidOnPort = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess
if ($pidOnPort) {
    Write-Host "端口 ${Port} 被占用 (PID: $pidOnPort)，正在释放..." -ForegroundColor Yellow
    Stop-Process -Id $pidOnPort -Force
    Start-Sleep -Milliseconds 500
}

Write-Host "Hugo Book - 启动开发服务器..." -ForegroundColor Cyan
Write-Host "地址: http://${HostAddr}:${Port}/" -ForegroundColor Green
Write-Host "按 Ctrl+C 停止`n" -ForegroundColor Yellow

hugo server --port $Port --bind $HostAddr --minify