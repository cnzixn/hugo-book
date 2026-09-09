#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查 DST 创意工坊描述中是否有明确的搬运/移植/再发布禁令。

用法：
    python data_src/check_dst_workshop_compliance.py
    python data_src/check_dst_workshop_compliance.py --limit 5
    python data_src/check_dst_workshop_compliance.py --refresh  # 强制全量重抓

结果默认写入 data_src/dst_workshop_compliance.json。该结果是人工复核清单，
“未检测到禁令”不等于获得作者授权。
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "dst_pan.json"
DEFAULT_OUTPUT = ROOT / "dst_workshop_compliance.json"
DEFAULT_PROCESSED = ROOT / "dst_workshop_processed.json"
API_URL = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"
WORKSHOP_URL = "https://steamcommunity.com/sharedfiles/filedetails/?id={}"

# 只把“禁止词”和“目标行为”联系起来，单独出现的 do not / upload 不标记。
PROHIBITION_RE = re.compile(
    r"(?:禁止|严禁|请勿|勿|不得|不允许|不准|谢绝|未经[^。；\n]{0,20}(?:许可|同意|授权)|"
    r"\b(?:do\s*not|don't|dont|never|no|not\s+allowed|not\s+permitted|"
    r"prohibited|forbidden|may\s+not|without\s+(?:my|our|the\s+author's?)\s+permission)\b)",
    re.IGNORECASE,
)
TARGET_RE = re.compile(
    r"(?:搬运|移植|转载|再发布|二次发布|重新发布|重发|转发|镜像|网盘|分享|上传|"
    r"\bre-?upload(?:ing)?\b|\bre-?publish(?:ing)?\b|\brepost(?:ing)?\b|"
    r"\bredistribut(?:e|ion|ing)\b|\bport(?:ing)?\b|\bmirror(?:ing)?\b|"
    r"\bre-?release(?:ing)?\b|\bre-?upload\b)",
    re.IGNORECASE,
)


def normalize_description(value):
    """去掉 Steam BBCode，并统一空白，便于匹配和人工阅读。"""
    text = re.sub(r"\[/?(?:b|i|u|h[1-6]|url(?:=[^]]+)?|img|list|\*|quote)[^]]*\]", " ", value or "", flags=re.I)
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


def find_prohibitions(description):
    """返回匹配片段；要求两个关键词距离不超过 180 字符。"""
    text = normalize_description(description)
    matches = []
    for prohibition in PROHIBITION_RE.finditer(text):
        nearby = text[max(0, prohibition.start() - 180):prohibition.end() + 180]
        if not TARGET_RE.search(nearby):
            continue
        start = max(0, prohibition.start() - 80)
        end = min(len(text), prohibition.end() + 120)
        snippet = text[start:end].strip()
        if snippet not in matches:
            matches.append(snippet)
    return matches


def load_items():
    with SOURCE.open("r", encoding="utf-8") as stream:
        data = json.load(stream)
    return [(key, value) for key, value in data.items() if re.fullmatch(r"WS\d+", key, re.I)]


def load_cache(output):
    if not output.exists():
        return {}
    try:
        with output.open("r", encoding="utf-8") as stream:
            return {item["id"]: item for item in json.load(stream).get("items", [])}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def load_processed_ids(path):
    """读取已完成中文稿清单；清单中的 ID 普通运行时不再请求 Steam。"""
    if not path.exists():
        return set()
    try:
        with path.open("r", encoding="utf-8") as stream:
            data = json.load(stream)
        return {str(item).upper() for item in data.get("completed_ids", [])}
    except (OSError, ValueError, TypeError):
        return set()


def fetch_details(ids, timeout, retries):
    payload = {"itemcount": len(ids)}
    payload.update({f"publishedfileids[{i}]": item_id for i, item_id in enumerate(ids)})
    request = Request(
        API_URL,
        data=urlencode(payload).encode("ascii"),
        headers={"User-Agent": "hugo-book-dst-compliance-check/1.0"},
        method="POST",
    )
    for attempt in range(retries + 1):
        try:
            with urlopen(request, timeout=timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
            return {item["publishedfileid"]: item for item in body.get("response", {}).get("publishedfiledetails", [])}
        except HTTPError as exc:
            if exc.code < 500 and exc.code != 429:
                raise RuntimeError(f"Steam 接口请求失败: HTTP {exc.code}") from exc
            if attempt >= retries:
                raise RuntimeError(f"Steam 接口请求失败: {exc}") from exc
            delay = 2 ** attempt
            print(f"  [重试] {exc}，{delay} 秒后重试", file=sys.stderr)
            time.sleep(delay)
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt >= retries:
                raise RuntimeError(f"Steam 接口请求失败: {exc}") from exc
            delay = 2 ** attempt
            print(f"  [重试] {exc}，{delay} 秒后重试", file=sys.stderr)
            time.sleep(delay)
    return {}


def make_item(item_id, source, detail=None, error=None):
    steam_id = re.sub(r"^WS", "", item_id, flags=re.I)
    description = (detail or {}).get("description", "")
    matches = find_prohibitions(description)
    status = "prohibited" if matches else ("no-description" if not description else "clear")
    if error:
        status = "error"
    return {
        "id": item_id,
        "name": source.get("name", ""),
        "title": (detail or {}).get("title", ""),
        "workshop_url": WORKSHOP_URL.format(steam_id),
        "status": status,
        "explicit_prohibition": bool(matches),
        "matched_snippets": matches,
        "description": description,
        "error": error or "",
        "time_updated": (detail or {}).get("time_updated", 0),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="报告 JSON 路径")
    parser.add_argument("--processed", type=Path, default=DEFAULT_PROCESSED, help="已完成中文稿清单")
    parser.add_argument("--limit", type=int, default=0, help="只检查前 N 个模组，便于试跑")
    parser.add_argument("--refresh", action="store_true", help="忽略报告中的缓存，重新请求")
    parser.add_argument("--timeout", type=float, default=20, help="单次请求超时秒数")
    parser.add_argument("--delay", type=float, default=0.2, help="批次之间的间隔秒数")
    args = parser.parse_args()

    sources = load_items()
    if args.limit > 0:
        sources = sources[:args.limit]
    cache = {} if args.refresh else load_cache(args.output)
    processed_ids = set() if args.refresh else load_processed_ids(args.processed)
    results = []
    pending = []
    skipped = 0

    for item_id, source in sources:
        normalized_id = item_id.upper()
        if not args.refresh and normalized_id in processed_ids:
            if item_id in cache:
                results.append(cache[item_id])
            else:
                results.append(make_item(item_id, source, error="已标记完成，但报告中缺少缓存记录"))
            skipped += 1
        elif item_id in cache:
            results.append(cache[item_id])
        elif item_id.upper() == "WS000000":
            results.append(make_item(item_id, source, error="占位 ID，不是有效的 Steam 工坊 ID"))
        else:
            pending.append((item_id, source))

    for offset in range(0, len(pending), 100):
        batch = pending[offset:offset + 100]
        steam_ids = [re.sub(r"^WS", "", item_id, flags=re.I) for item_id, _ in batch]
        details = fetch_details(steam_ids, args.timeout, 2)
        for item_id, source in batch:
            steam_id = re.sub(r"^WS", "", item_id, flags=re.I)
            detail = details.get(steam_id)
            error = None if detail else "Steam 未返回该工坊条目"
            results.append(make_item(item_id, source, detail, error))
        if offset + 100 < len(pending):
            time.sleep(max(0, args.delay))
        print(f"[进度] {min(offset + 100, len(pending))}/{len(pending)} 个新条目")

    results.sort(key=lambda item: item["id"])
    report = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source": str(SOURCE.name),
        "processed_manifest": str(args.processed.name),
        "note": "clear 仅表示未检测到明确禁令，仍需人工核对原描述和联系作者；error/no-description 不应视为许可。",
        "summary": {
            "total": len(results),
            "prohibited": sum(item["status"] == "prohibited" for item in results),
            "clear": sum(item["status"] == "clear" for item in results),
            "no_description": sum(item["status"] == "no-description" for item in results),
            "error": sum(item["status"] == "error" for item in results),
            "invalid_id": sum(item["error"].startswith("占位 ID") for item in results),
            "skipped_existing": skipped,
        },
        "items": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(f"[跳过] 已有处理记录: {skipped} 条")
    print(json.dumps(report["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()