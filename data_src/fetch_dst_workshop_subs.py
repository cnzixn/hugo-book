#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 DST 创意工坊模组的 Steam 订阅数，写入 dst_pan.yml / dst_pan.json。

数据来源：Steam 官方接口
    POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/
返回字段（本次只取前两个）：
    subscriptions          当前订阅数（仍在订阅的人数）→ 写入 `subs`，页面「按下载」排序用
    lifetime_subscriptions 历史累计订阅次数 → 写入 `lifetime_subs`，仅作参考

写回格式（与原有 `- 字段: 值` 列表风格保持一致）：
    WS376333686:
    - name: 综合状态CombinedStatus
    - tags: 辅助、信息
    - subs: 10327240
    - lifetime_subs: 11324613
    - url1: https://pan.baidu.com/s/...
    - ...
    - size: 357.32KB

说明：
  * 幂等：重复运行只更新已有 `- subs:` / `- lifetime_subs:` 行的值，行位置和字段顺序不变。
  * 同时补写 `data_src/dst_pan.json`（`pan_yml2json.py` 的产物），保持 yml/json 一致。
  * 默认同时处理 `data/dst_pan.yml` 与 `data_src/dst_pan.yml`（仓库里两份内容相同）。
  * `--dry-run` 只打印结果不落盘；Steam 偶发 504/超时，脚本按 `--retries` 指数退避重试。
  * WS000000 不是有效工坊 ID，会被自动跳过（Steam 不会返回条目）。

用法：
    python data_src/fetch_dst_workshop_subs.py              # 抓取并写回
    python data_src/fetch_dst_workshop_subs.py --dry-run    # 只看结果
    python data_src/fetch_dst_workshop_subs.py --limit 5    # 试跑前 5 个
    python data_src/fetch_dst_workshop_subs.py --only WS376333686 WS2398672953
"""

import argparse
import json
import re
import sys
import time
from collections import OrderedDict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

DEFAULT_YML = [
    REPO / "data" / "dst_pan.yml",
    ROOT / "dst_pan.yml",
]
DEFAULT_JSON = [ROOT / "dst_pan.json"]
API_URL = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"
BATCH_SIZE = 100        # Steam 单次请求上限
SUB_FIELDS = ("subs", "lifetime_subs")

KEY_RE = re.compile(r"^(?P<key>[^:\s-][^:]*):\s*$")
FIELD_RE = re.compile(r"^\s*-\s*(?P<k>[A-Za-z0-9_]+):(?P<v>.*?)\s*$")


# --------------------------------------------------------------------------
# 解析 / 写回
# --------------------------------------------------------------------------
def parse_yml(path):
    """行级解析 `- 字段: 值` 风格 yml，返回 {key: {field: 值}} 与原始行号。"""
    items = OrderedDict()
    if not path.exists():
        return items
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            line = line.rstrip("\r\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            m_key = KEY_RE.match(line)
            if m_key:
                key = m_key.group("key").strip()
                items[key] = OrderedDict()
                continue
            m_field = FIELD_RE.match(line)
            if m_field and items:
                last_key = next(reversed(items))
                items[last_key][m_field.group("k")] = m_field.group("v").strip()
    return items


def split_blocks(lines):
    """按顶层 key 行切块：[(key 或 None, [行...])]，key 行本身包含在块内。"""
    blocks = []
    current = (None, [])
    for line in lines:
        m_key = KEY_RE.match(line)
        if m_key and not line.startswith((" ", "\t")):
            blocks.append(current)
            current = (m_key.group("key").strip(), [line])
        else:
            current[1].append(line)
    blocks.append(current)
    return [block for block in blocks if block[1]]


def patch_yml(path, subs_map, dry_run):
    """把 subs/lifetime_subs 写回 yml：已有行原地更新，缺失行按 SUB_FIELDS 顺序插在 size 之前。

    返回 (新增行数, 值有变化的行数)；重复运行第二次起必然是 (0, 0)。
    """
    # 注意：必须显式 newline="" —— 默认的通用换行模式会把 CRLF 读成 LF，
    # 写回时就变成纯 LF，整文件 diff 会被换行符污染。
    with path.open("r", encoding="utf-8", newline="") as stream:
        text = stream.read()
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(nl)
    if lines and lines[-1] == "":
        lines.pop()

    blocks = split_blocks(lines)

    inserted, updated = 0, 0
    out_blocks = []
    for key, block in blocks:
        if key not in subs_map:
            out_blocks.append(block)
            continue
        fields = subs_map[key]
        # 先记下旧的 subs / lifetime_subs 值并删掉这些行，再统一插入到 size 之前
        old_values = {}
        stripped = []
        for line in block:
            m = FIELD_RE.match(line)
            if m and m.group("k") in SUB_FIELDS:
                old_values[m.group("k")] = m.group("v").strip()
                continue
            stripped.append(line)
        size_pos = len(stripped)
        for i, line in enumerate(stripped):
            m = FIELD_RE.match(line)
            if m and m.group("k") == "size":
                size_pos = i
                break
        new_lines = ["- %s: %s" % (field, fields[field]) for field in SUB_FIELDS]
        for field in SUB_FIELDS:
            if field not in old_values:
                inserted += 1
            elif old_values[field] != str(fields[field]):
                updated += 1
        out_blocks.append(stripped[:size_pos] + new_lines + stripped[size_pos:])

    body = nl.join([line for block in out_blocks for line in block]) + nl
    if not dry_run and (inserted or updated):
        with path.open("w", encoding="utf-8", newline="") as stream:
            stream.write(body)
    return inserted, updated


def patch_json(path, subs_map, dry_run):
    """同步写回 dst_pan.json（保持 order：subs 插在 size 之前）。"""
    if not path.exists():
        return False
    with path.open("r", encoding="utf-8") as stream:
        data = json.load(stream, object_pairs_hook=OrderedDict)

    changed = False
    for key, fields in subs_map.items():
        entry = data.get(key)
        if entry is None:
            continue
        if entry.get("subs") == fields["subs"] and entry.get("lifetime_subs") == fields["lifetime_subs"]:
            continue
        changed = True
        rebuilt = OrderedDict()
        for field, value in entry.items():
            if field in SUB_FIELDS:
                continue
            if field == "size":
                rebuilt["subs"] = fields["subs"]
                rebuilt["lifetime_subs"] = fields["lifetime_subs"]
            rebuilt[field] = value
        if "subs" not in rebuilt:
            rebuilt["subs"] = fields["subs"]
            rebuilt["lifetime_subs"] = fields["lifetime_subs"]
        data[key] = rebuilt

    if changed and not dry_run:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return changed


# --------------------------------------------------------------------------
# Steam 接口
# --------------------------------------------------------------------------
def fetch_batch(ids, timeout, retries):
    payload = {"itemcount": len(ids)}
    payload.update({f"publishedfileids[{i}]": item_id for i, item_id in enumerate(ids)})
    for attempt in range(retries + 1):
        request = Request(
            API_URL,
            data=urlencode(payload).encode("ascii"),
            headers={"User-Agent": "hugo-book-dst-subs/1.0", "Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
            return {
                item["publishedfileid"]: item
                for item in body.get("response", {}).get("publishedfiledetails", [])
            }
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            code = getattr(exc, "code", 0)
            if code and code < 500 and code != 429:
                raise RuntimeError(f"Steam 接口请求失败: HTTP {code}") from exc
            if attempt >= retries:
                raise RuntimeError(f"Steam 接口请求失败: {exc}") from exc
            delay = 2 ** attempt
            print(f"  [重试] {exc}，{delay} 秒后重试", file=sys.stderr)
            time.sleep(delay)
    return {}


def steam_id_of(key):
    return re.sub(r"^WS", "", key, flags=re.I)


def display_path(path):
    """尽量显示仓库内相对路径（Windows 控制台编码不稳，纯 ASCII 路径更安全）。"""
    try:
        return path.resolve().relative_to(REPO).as_posix()
    except ValueError:
        return path.as_posix()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--yml", type=Path, action="append", default=None, help="目标 yml（可多次指定，默认 data/ 与 data_src/ 两份）")
    parser.add_argument("--json", type=Path, action="append", default=None, help="目标 json（可多次指定，默认 data_src/dst_pan.json）")
    parser.add_argument("--only", nargs="+", default=None, help="只抓取指定 key（如 WS376333686）")
    parser.add_argument("--limit", type=int, default=0, help="只抓取前 N 个，便于试跑")
    parser.add_argument("--timeout", type=float, default=30, help="单次请求超时秒数")
    parser.add_argument("--retries", type=int, default=3, help="失败重试次数")
    parser.add_argument("--delay", type=float, default=1.0, help="批次间隔秒数")
    parser.add_argument("--dry-run", action="store_true", help="只抓取并打印，不写入文件")
    args = parser.parse_args()

    yml_targets = args.yml or DEFAULT_YML
    json_targets = args.json or DEFAULT_JSON

    base = parse_yml(yml_targets[0])
    keys = [k for k in base if re.fullmatch(r"WS\d+", k, re.I)]
    if args.only:
        wanted = {k.upper() for k in args.only}
        keys = [k for k in keys if k.upper() in wanted]
    if args.limit > 0:
        keys = keys[:args.limit]

    fetch_keys = [k for k in keys if k.upper() != "WS000000"]
    if len(fetch_keys) != len(keys):
        print("[跳过] WS000000 不是有效的 Steam 工坊 ID")

    subs_map = OrderedDict()
    for offset in range(0, len(fetch_keys), BATCH_SIZE):
        batch = fetch_keys[offset:offset + BATCH_SIZE]
        steam_ids = [steam_id_of(k) for k in batch]
        details = fetch_batch(steam_ids, args.timeout, args.retries)
        for key in batch:
            detail = details.get(steam_id_of(key))
            if not detail:
                print(f"[缺失] {key} Steam 未返回该条目", file=sys.stderr)
                continue
            subs = int(detail.get("subscriptions") or 0)
            lifetime = int(detail.get("lifetime_subscriptions") or 0)
            subs_map[key] = {"subs": subs, "lifetime_subs": lifetime}
            print(f"  {key}  订阅 {subs:>10,}  累计 {lifetime:>10,}  {detail.get('title', '')}")
        if offset + BATCH_SIZE < len(fetch_keys):
            time.sleep(max(0, args.delay))

    if not subs_map:
        print("[WARN] 没有抓到任何数据，未做任何修改")
        return 1

    for target in yml_targets:
        inserted, updated = patch_yml(target, subs_map, args.dry_run)
        action = "预览" if args.dry_run else "写入"
        print(f"[{action}] {display_path(target)}：新增 {inserted} 行，更新 {updated} 行")
    for target in json_targets:
        changed = patch_json(target, subs_map, args.dry_run)
        action = "预览" if args.dry_run else "写入"
        print(f"[{action}] {display_path(target)}：{'有变动' if changed else '无变动'}")

    ranked = sorted(subs_map.items(), key=lambda kv: kv[1]["subs"], reverse=True)
    print("\n订阅数 Top 5：")
    for key, value in ranked[:5]:
        print(f"  {key}  {value['subs']:,}")
    print("订阅数 Bottom 3：")
    for key, value in ranked[-3:]:
        print(f"  {key}  {value['subs']:,}")
    print(f"\n共 {len(subs_map)} 条；中位订阅数 {ranked[len(ranked) // 2][1]['subs']:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
