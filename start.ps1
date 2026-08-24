# Hugo 一键启动脚本

# 设置控制台编码为 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 >$null

# 自动切换到脚本所在目录
Set-Location $PSScriptRoot

# 修改下面两行可自定义端口和主机地址
$Port = 1313
$HostAddr = "0.0.0.0"

# 获取本机局域网 IP 地址
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -ExpandProperty IPAddress -First 1)

# 刷新 PATH 以加载 winget 安装的 Hugo
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# 自动释放被占用的端口（无需管理员权限）
$netstatLine = netstat -ano | Select-String ":$Port\s" | Select-Object -First 1
if ($netstatLine) {
    $pidOnPort = ($netstatLine -split '\s+')[-1]
    Write-Host "端口 ${Port} 被占用 (PID: $pidOnPort)，正在释放..." -ForegroundColor Yellow
    Stop-Process -Id $pidOnPort -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

Write-Host "Hugo Book - 启动开发服务器..." -ForegroundColor Cyan
Write-Host "本机访问: http://localhost:${Port}/" -ForegroundColor Green
if ($lanIp) {
    Write-Host "局域网访问: http://${lanIp}:${Port}/" -ForegroundColor Green
}
Write-Host "按 Ctrl+C 停止`n" -ForegroundColor Yellow

hugo server --source "$PSScriptRoot" --port $Port --bind $HostAddr --minify