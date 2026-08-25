#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hugo 一键启动脚本 (Python 版，跨平台兼容 Windows/Linux/macOS)
"""

import os
import sys
import socket
import subprocess
import time


def get_lan_ip():
    """获取本机局域网 IP 地址"""
    try:
        # 创建 socket 连接到外网来获取本地 IP（不实际发送数据）
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        # 排除 localhost
        if ip != "127.0.0.1":
            return ip
    except Exception:
        pass

    # 回退方案：遍历网卡
    try:
        import psutil
        for addr in psutil.net_if_addrs().values():
            for netaddr in addr:
                if netaddr.family == socket.AF_INET:
                    ip = netaddr.address
                    if not ip.startswith("127."):
                        return ip
    except ImportError:
        pass

    return None


def release_port(port):
    """释放被占用的端口"""
    if sys.platform == "win32":
        try:
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True, text=True
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    pid = line.strip().split()[-1]
                    print(f"\033[33m端口 {port} 被占用 (PID: {pid})，正在释放...\033[0m")
                    subprocess.run(["taskkill", "/F", "/PID", pid],
                                   capture_output=True)
                    time.sleep(0.5)
                    return
        except Exception:
            pass
    else:
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True, text=True
            )
            if result.stdout.strip():
                pid = result.stdout.strip().split("\n")[0]
                print(f"\033[33m端口 {port} 被占用 (PID: {pid})，正在释放...\033[0m")
                subprocess.run(["kill", "-9", pid], capture_output=True)
                time.sleep(0.5)
        except Exception:
            pass


def main():
    # 自动切换到脚本所在目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    # 配置
    PORT = 1313
    HOST_ADDR = "0.0.0.0"

    # 获取局域网 IP
    lan_ip = get_lan_ip()

    # 释放端口
    release_port(PORT)

    # 输出信息
    print("\033[36mHugo Book - 启动开发服务器...\033[0m")
    print(f"\033[32m本机访问: http://localhost:{PORT}/\033[0m")
    if lan_ip:
        print(f"\033[32m局域网访问: http://{lan_ip}:{PORT}/\033[0m")
    else:
        print("\033[33m警告: 无法获取局域网 IP，可能仅本机可访问\033[0m")
    print("\033[33m按 Ctrl+C 停止\033[0m\n")

    # 构建 baseURL
    base_url = f"http://{lan_ip or 'localhost'}:{PORT}/"

    # 启动 Hugo server
    cmd = [
        "hugo", "server",
        "--source", ".",
        "--port", str(PORT),
        "--bind", HOST_ADDR,
        "--minify",
        "--baseURL", base_url
    ]

    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\n\033[36m服务器已停止\033[0m")
    except FileNotFoundError:
        print("\033[31m错误: 未找到 'hugo' 命令，请确保 Hugo 已安装并在 PATH 中\033[0m")
        sys.exit(1)


if __name__ == "__main__":
    main()