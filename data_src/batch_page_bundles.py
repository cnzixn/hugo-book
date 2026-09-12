# -*- coding: utf-8 -*-
"""批量把 Hugo 的散落 Markdown 页面转换为 page bundle。

例如：
    content/docs/.../mods/WS2302837868.md

会转换为：
    content/docs/.../mods/WS2302837868/index.md

默认只预览，不修改文件。确认列表无误后使用 --apply；如需删除原始
Markdown 文件，再额外传入 --delete-source。
"""

import argparse
import os
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "content" / "docs" / "dst-book" / "section-2-resources" / "mods"


def find_markdown_files(source_dir: Path):
    """只返回当前目录的页面文件，不处理已有 bundle 或目录索引。"""
    return sorted(
        path
        for path in source_dir.glob("*.md")
        if path.name != "_index.md"
    )


def convert_file(source_file: Path, apply: bool, delete_source: bool, force: bool):
    bundle_dir = source_file.with_suffix("")
    target_file = bundle_dir / "index.md"

    if bundle_dir.exists() and not bundle_dir.is_dir():
        return "error", f"目标路径不是目录，跳过: {bundle_dir}"
    if target_file.exists() and not force:
        return "skip", f"目标已存在，跳过: {target_file}"

    action = "覆盖" if target_file.exists() else "创建"
    if not apply:
        return "plan", f"{action}: {source_file} -> {target_file}"

    bundle_dir.mkdir(exist_ok=True)
    shutil.copy2(source_file, target_file)
    if delete_source:
        source_file.unlink()
    return "done", f"{action}: {source_file} -> {target_file}"


def main():
    parser = argparse.ArgumentParser(description="批量转换 Hugo Markdown page bundle")
    parser.add_argument(
        "source",
        nargs="?",
        type=Path,
        default=DEFAULT_SOURCE,
        help="待处理目录，默认是 dst-book/section-2-resources/mods",
    )
    parser.add_argument("--apply", action="store_true", help="实际创建 bundle，默认只预览")
    parser.add_argument("--dry-run", action="store_true", help="只预览转换计划（默认行为）")
    parser.add_argument(
        "--delete-source",
        action="store_true",
        help="转换成功后删除原始 .md 文件，必须和 --apply 一起使用",
    )
    parser.add_argument("--force", action="store_true", help="目标 index.md 已存在时覆盖")
    args = parser.parse_args()

    source_dir = args.source if args.source.is_absolute() else ROOT / args.source
    source_dir = source_dir.resolve()
    if not source_dir.is_dir():
        parser.error(f"目录不存在: {source_dir}")
    if args.delete_source and not args.apply:
        parser.error("--delete-source 必须和 --apply 一起使用")

    files = find_markdown_files(source_dir)
    if not files:
        print(f"未找到待处理的 Markdown 文件: {source_dir}")
        return

    counts = {"plan": 0, "done": 0, "skip": 0, "error": 0}
    for source_file in files:
        status, message = convert_file(
            source_file,
            apply=args.apply,
            delete_source=args.delete_source,
            force=args.force,
        )
        counts[status] += 1
        print(f"[{status.upper()}] {message}")

    mode = "已执行" if args.apply else "预览完成"
    print(
        f"\n{mode}: {len(files)} 个文件，"
        f"创建/计划 {counts['done'] + counts['plan']}，"
        f"跳过 {counts['skip']}，错误 {counts['error']}"
    )
    if not args.apply:
        print("确认无误后追加 --apply；如需删除原文件再追加 --delete-source。")
    if counts["error"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()