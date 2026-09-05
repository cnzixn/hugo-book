#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hugo 文章本地编辑器
====================
用法：
    python editor.py
然后浏览器打开 http://localhost:8770/

功能：
    - 列出 content/posts/ 下的文章
    - 表单化新建 / 编辑文章（标题、日期、分类、标签、描述、正文）
    - 保存为 Hugo 格式的 Markdown（自动生成 YAML front matter）
    - 一键执行 hugo 构建
    - 一键在 hugo server（start.py，端口 1313）中预览

依赖：仅 Python 标准库，无需安装任何第三方包。
"""

import json
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# 控制台输出统一 UTF-8，避免 Windows 下中文打印报错
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

PORT = 8770
ROOT = Path(__file__).resolve().parent
POSTS_DIR = ROOT / "content" / "posts"
INDEX_FILE = ROOT / "editor" / "index.html"

# 文件名只允许：中文、英文字母、数字、下划线、连字符（防止路径穿越）
_SLUG_RE = re.compile(r"^[\u4e00-\u9fffA-Za-z0-9_\-]+$")


def slugify(title: str) -> str:
    """由标题生成默认文件名（保留中文，空格/非法字符转连字符）"""
    s = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9_\-]+", "-", (title or "").strip())
    return s.strip("-") or "untitled"


def safe_slug(slug: str):
    """校验文件名，不合法返回 None"""
    slug = (slug or "").strip()
    return slug if _SLUG_RE.match(slug) else None


# ---------------------------------------------------------------------------
# 极简 YAML front matter 解析/序列化（覆盖本站文章用到的字段：
# 标量、带引号字符串、行内数组 [a, b]）
# ---------------------------------------------------------------------------
def parse_fm(text: str) -> dict:
    data = {}
    for raw in text.split("\n"):
        line = raw.rstrip("\r\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_\-]+)\s*:\s*(.*)$", stripped)
        if not m:
            continue
        key = m.group(1)
        val = m.group(2).strip()
        if val == "":
            data[key] = ""
        elif val.startswith("[") and val.endswith("]"):
            try:
                data[key] = json.loads(val)
            except Exception:
                inner = val[1:-1]
                data[key] = [x.strip().strip('"\'') for x in inner.split(",") if x.strip()]
        elif len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            data[key] = val[1:-1]
        else:
            data[key] = val
    return data


def dump_fm(data: dict) -> str:
    """把 dict 序列化为 YAML front matter 块（含首尾 ---）"""
    order = ["title", "date", "tags", "categories", "description"]
    keys = [k for k in order if k in data]
    keys += [k for k in data if k not in order]

    lines = ["---"]
    for key in keys:
        val = data[key]
        if val is None or val == "" or val == []:
            continue
        if isinstance(val, list):
            items = ", ".join(json.dumps(str(x), ensure_ascii=False) for x in val)
            lines.append(f"{key}: [{items}]")
        elif isinstance(val, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", val):
            # 日期不带引号，保持 Hugo 常见写法
            lines.append(f"{key}: {val}")
        else:
            lines.append(f'{key}: {json.dumps(str(val), ensure_ascii=False)}')
    lines.append("---")
    return "\n".join(lines) + "\n"


def load_post(path: Path):
    """读取文章，返回 (front_matter dict, 正文)"""
    text = path.read_text(encoding="utf-8")
    data, body = {}, text
    if text.startswith("---"):
        rest = text[3:]
        lines = rest.split("\n")
        fm_lines = []
        body_lines = None
        for i, line in enumerate(lines):
            if line.rstrip("\r\n") == "---":
                body_lines = lines[i + 1:]
                break
            fm_lines.append(line)
        data = parse_fm("\n".join(fm_lines))
        body = "\n".join(body_lines) if body_lines is not None else ""
    return data, body


def list_posts():
    posts = []
    for p in sorted(POSTS_DIR.glob("*.md")):
        if p.name == "_index.md":
            continue
        data, _ = load_post(p)
        posts.append({
            "slug": p.stem,
            "title": data.get("title", p.stem),
            "date": data.get("date", ""),
        })
    posts.sort(key=lambda x: x["date"], reverse=True)
    return posts


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def do_GET(self):
        parts = urlsplit(self.path)
        path = parts.path
        qs = parse_qs(parts.query)

        if path in ("/", "/index.html"):
            try:
                html = INDEX_FILE.read_text(encoding="utf-8")
            except FileNotFoundError:
                self._send(500, "editor/index.html 不存在", "text/plain; charset=utf-8")
                return
            self._send(200, html, "text/html; charset=utf-8")
        elif path == "/api/posts":
            self._json(200, {"posts": list_posts()})
        elif path == "/api/post":
            slug = safe_slug(qs.get("slug", [""])[0])
            if not slug:
                self._json(400, {"error": "非法文件名"})
                return
            p = POSTS_DIR / f"{slug}.md"
            if not p.exists():
                self._json(404, {"error": "文章不存在"})
                return
            data, body = load_post(p)
            self._json(200, {"slug": slug, **data, "body": body})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        parts = urlsplit(self.path)
        path = parts.path
        req = self._read_json()
        if req is None:
            self._json(400, {"error": "请求体不是合法 JSON"})
            return

        if path == "/api/save":
            self._handle_save(req)
        elif path == "/api/build":
            self._handle_build()
        else:
            self._json(404, {"error": "not found"})

    def _handle_save(self, req):
        title = str(req.get("title", "")).strip()
        slug = safe_slug(req.get("slug", "")) or slugify(title)
        if not slug:
            self._json(400, {"error": "文件名非法（仅限中英文、数字、-、_）"})
            return

        date = str(req.get("date", "")).strip()
        tags = [str(t).strip() for t in req.get("tags", []) if str(t).strip()]
        categories = [str(c).strip() for c in req.get("categories", []) if str(c).strip()]
        description = str(req.get("description", "")).strip()
        body = str(req.get("body", ""))

        data = {
            "title": title,
            "date": date,
            "tags": tags,
            "categories": categories,
            "description": description,
        }
        fm = dump_fm(data)
        path = POSTS_DIR / f"{slug}.md"
        try:
            path.write_text(fm + "\n" + body.rstrip() + "\n", encoding="utf-8")
        except OSError as e:
            self._json(500, {"error": f"写入失败: {e}"})
            return
        self._json(200, {"ok": True, "slug": slug, "path": str(path.relative_to(ROOT))})

    def _handle_build(self):
        try:
            result = subprocess.run(
                ["hugo"],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=300,
            )
            self._json(200, {
                "ok": result.returncode == 0,
                "exitCode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            })
        except FileNotFoundError:
            self._json(200, {"ok": False, "error": "未找到 hugo 命令，请确认已安装并在 PATH 中"})
        except subprocess.TimeoutExpired:
            self._json(200, {"ok": False, "error": "构建超时（300s）"})

    def log_message(self, fmt, *args):
        print(f"[editor] {fmt % args}")


def main():
    os.chdir(ROOT)
    if not POSTS_DIR.exists():
        print(f"未找到文章目录: {POSTS_DIR}")
        sys.exit(1)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("Hugo 文章编辑器已启动")
    print(f"本机访问: http://localhost:{PORT}/")
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
