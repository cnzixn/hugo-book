# -*- coding: utf-8 -*-
"""
通用 pan yml 合并脚本（自动扫描 ds / dst 等前缀）
--------------------------------------------------
自动扫描脚本所在目录下所有 `{prefix}-{source}.txt`，
按 prefix 分组后分别合并到 `{prefix}_pan.yml`。

命名约定：
    ds-baidu.txt + ds-quark.txt  →  ds_pan.yml   （单机版）
    dst-baidu.txt + dst-quark.txt →  dst_pan.yml  （联机版）
    也支持自定义前缀，只要文件名符合 `{prefix}-{source}.txt` 格式。

原始 txt 格式（每个条目 3 行一组）：
    第1行: {MOD_ID}.{中文名}.zip\t{文件大小}\t   （tab 分隔，末尾 tab 可选）
    第2行: https://pan.baidu.com/s/xxx?pwd=xxxx  或  https://pan.quark.cn/s/xxx
    第3行: {提取码}\t分享成功

输出 {prefix}_pan.yml 格式（同目录下已有示例为参照）：
    {MOD_ID}:
    - name: {中文名}
    - tags: {可选标签，非空才输出}
    - url1: {百度网盘链接（已带?pwd）}
    - url2: https://pan.xunlei.com   （迅雷暂无数据，写占位URL）
    - url3: {夸克网盘链接（自动补?pwd=提取码）}
    - size: {文件大小}

注意：
* 保留 dst_pan.yml 中 **已存在** 的条目（按 WS编号去重，旧条目优先不被覆盖），
  仅把 txt 里新出现的 WS编号追加到文件末尾。
* 编码一律 utf-8。
* 迅雷链接（url2）如果当前 txt 没有对应数据源，则统一写占位：https://pan.xunlei.com
"""

import os
import re
import shutil
import sys
from collections import OrderedDict

# ---------- 路径配置 ----------
# 脚本、原料 txt、输出 yml 均放在 hugo-book/data_src/ 同一目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

XUNLEI_PLACEHOLDER = "https://pan.xunlei.com"

# 支持的 txt 来源后缀（{prefix}-{SOURCE}.txt）
KNOWN_SOURCES = ("baidu", "quark")


def discover_prefixes():
    """
    扫描 BASE_DIR，按前缀分组返回 { prefix: { source: filepath } }。
    例如：{ "ds": {"baidu": ".../ds-baidu.txt", "quark": ".../ds-quark.txt"} }
    """
    groups = {}
    for fname in os.listdir(BASE_DIR):
        if not fname.endswith(".txt"):
            continue
        # 匹配 {prefix}-{source}.txt
        m = re.match(r"^(.+)-([a-zA-Z]+)\.txt$", fname)
        if not m:
            continue
        prefix = m.group(1).lower()
        source = m.group(2).lower()
        if source not in KNOWN_SOURCES:
            continue
        fpath = os.path.join(BASE_DIR, fname)
        groups.setdefault(prefix, {})[source] = fpath
    return groups


def parse_pan_txt(txt_path):
    """
    解析 百度/夸克 txt，返回 { ws_id: {url, size, name, pwd} }
    name 去掉尾部 .zip；size 原样保留（如 "127.24MB"）。
    """
    result = {}
    if not os.path.exists(txt_path):
        print("[WARN] 文件不存在，跳过: " + txt_path)
        return result

    with open(txt_path, "r", encoding="utf-8") as f:
        lines = [ln.rstrip("\r\n") for ln in f.readlines()]

    # 去掉空行
    lines = [ln for ln in lines if ln.strip() != ""]

    i = 0
    while i + 2 < len(lines):
        line1 = lines[i]      # 文件名行
        line2 = lines[i + 1]  # URL 行
        line3 = lines[i + 2]  # 提取码行

        # 第1行：按 tab 拆，第0段是 "WSxxx.name.zip"
        parts1 = line1.split("\t")
        filename = parts1[0].strip()
        size = parts1[1].strip() if len(parts1) > 1 else "0B"

        # "WS3597024951.景熹家居.zip" → ws_id="WS3597024951", name="景熹家居"
        # 允许中间带多个点：第一段是WSid，中间都是name，最后去掉.zip
        if filename.lower().endswith(".zip"):
            body = filename[:-4]
        else:
            body = filename
        dot_pos = body.find(".")
        if dot_pos == -1:
            # 奇怪格式就整体当 name，WS id 空
            i += 3
            continue
        ws_id = body[:dot_pos]
        name = body[dot_pos + 1:]

        # 第2行：URL
        url = line2.strip()

        # 第3行：提取码（"4ro6\t分享成功" → 取 tab 前）
        pwd_part = line3.split("\t")[0].strip()
        # 夸克 URL 本身如果没有带 pwd 参数，追加 ?pwd=xxx
        if "pan.quark.cn" in url.lower() and "pwd=" not in url:
            sep = "&" if ("?" in url) else "?"
            url = url + sep + "pwd=" + pwd_part

        result[ws_id] = {
            "name": name,
            "url": url,
            "size": size,
            "pwd": pwd_part,
        }
        i += 3

    print("[INFO] %s 解析 %d 条记录" % (os.path.basename(txt_path), len(result)))
    return result


def parse_existing_yml(yml_path):
    """
    读取已有的 dst_pan.yml，用 OrderedDict 返回：
        { key: { name, url1, url2, url3, size } }
    保持原顺序不变，便于之后写回。

    兼容性说明：
      * key 可以是 "WSxxx"，也可以是 "LocalSend"、"游戏" 等任意非空字符串（行首非 `-`、以 `:` 结尾即作为 key）
      * 5 个字段（name/url1/url2/url3/size）顺序随意，不要求固定位置
      * 不依赖 PyYAML，按行逐段解析，避免用户安装依赖
    """
    result = OrderedDict()
    if not os.path.exists(yml_path):
        return result

    with open(yml_path, "r", encoding="utf-8") as f:
        lines = [ln.rstrip("\r\n") for ln in f.readlines()]

    # 匹配 key 行：行首无缩进 + 以 ":" 结尾（key 本身不含 ":"，避免把 "http:" 当 key）
    key_re = re.compile(r"^(?P<key>[^:\s-][^:]*):\s*$")
    # 匹配字段行：- field: value（支持 name/url1/url2/url3/size/tags）
    field_re = re.compile(r"^\s*-\s*(?P<k>name|url1|url2|url3|size|tags):\s*(?P<v>.*?)\s*$")

    cur_key = None
    cur_item = None

    def flush():
        """把当前累积的条目写入 result"""
        if cur_key is not None and cur_item is not None:
            # 缺失的字段补空（tags 也补空，确保后续 merge 不会 KeyError）
            for f2 in ("name", "url1", "url2", "url3", "size", "tags"):
                if f2 not in cur_item:
                    cur_item[f2] = ""
            result[cur_key] = cur_item

    for ln in lines:
        if ln.strip() == "":
            continue  # 跳过空行
        m_key = key_re.match(ln)
        if m_key:
            flush()  # 写掉上一个条目
            cur_key = m_key.group("key").strip()
            cur_item = {}
            continue
        m_field = field_re.match(ln)
        if m_field and cur_item is not None:
            cur_item[m_field.group("k")] = m_field.group("v")

    # 文件结束时 flush 最后一条
    flush()

    print("[INFO] %s 已存在条目 %d 条" % (os.path.basename(yml_path), len(result)))
    return result


def merge_data(baidu_map, quark_map, existing_map):
    """
    合并策略（"智能更新"：txt 有有效值才覆盖对应字段，绝不拿空串抹掉用户手动维护的旧值）：

      * 新条目（yml 里不存在该 key）→ 组装 name/url1/url2/url3/size 追加
      * 已存在条目 → 按字段逐列更新：
          - name / size：百度优先 → 夸克兜底 → 仍沿用旧值（txt 缺这列就不动）
          - url1（百度）：只有 txt 里有百度记录且百度 url 非空时覆盖
          - url3（夸克）：只有 txt 里有夸克记录且夸克 url 非空时覆盖
          - url2（迅雷）：**永远不自动覆盖**，完全沿用旧值；仅新条目写占位
    保证：
      * 迅雷手动填的真实链接不会被 txt 空值/占位冲掉
      * 单侧缺失（只有百度没有夸克）不会把旧夸克链接抹空
      * 重复运行幂等（无变化时一条都不改）
    """
    merged = OrderedDict(list(existing_map.items()))  # 保留原顺序
    added = 0
    updated = 0

    # 取百度与夸克记录的并集（百度里有但夸克里没有，或相反，都处理）
    all_ws = set(list(baidu_map.keys()) + list(quark_map.keys()))

    for ws in sorted(all_ws):
        b = baidu_map.get(ws)
        q = quark_map.get(ws)

        if ws in merged:
            # ---- 已存在条目：逐字段智能更新 ----
            old = merged[ws]
            new_name = old.get("name", "")
            new_size = old.get("size", "0B")
            new_url1 = old.get("url1", "")
            new_url2 = old.get("url2", "")  # 迅雷保持不动
            new_url3 = old.get("url3", "")
            changed = False

            # name / size：百度优先，没有则夸克兜底（非空才覆盖）
            primary = b or q
            if primary:
                if primary.get("name") and primary["name"] != new_name:
                    new_name = primary["name"]
                    changed = True
                if primary.get("size") and primary["size"] != new_size:
                    new_size = primary["size"]
                    changed = True

            # url1（百度）：有数据且非空才覆盖
            if b and b.get("url") and b["url"] != new_url1:
                new_url1 = b["url"]
                changed = True

            # url3（夸克）：有数据且非空才覆盖
            if q and q.get("url") and q["url"] != new_url3:
                new_url3 = q["url"]
                changed = True

            if changed:
                # 保留旧条目里的 tags（merge 不覆盖 tags，tag 由用户手动维护）
                new_tags = old.get("tags", "")
                merged[ws] = {
                    "name": new_name,
                    "url1": new_url1,
                    "url2": new_url2,
                    "url3": new_url3,
                    "size": new_size,
                    "tags": new_tags,
                }
                updated += 1
            # else：没有任何变化，完全保留原 dict，保证写回字节级一致
        else:
            # ---- 新条目：组装完整结构 ----
            primary = b or q
            name = primary["name"] if primary else ""
            size = primary["size"] if primary else "0B"
            url1 = b["url"] if b else ""
            url2 = XUNLEI_PLACEHOLDER  # 迅雷占位
            url3 = q["url"] if q else ""

            merged[ws] = {
                "name": name,
                "url1": url1,
                "url2": url2,
                "url3": url3,
                "size": size,
                "tags": "",  # 新条目无 tag，后续由用户手动维护或由 migrate_tags.py 补充
            }
            added += 1

    print("[INFO] 新增 %d 条，更新 %d 条（合并后共 %d 条）" % (added, updated, len(merged)))
    return merged


def write_yml(yml_path, merged_map):
    """
    按固定格式写回 yml（key + 字段行），条目之间空一行分隔。
    可选字段：tags 非空时输出，空则省略。
    不使用 PyYAML，避免用户装依赖。
    """
    lines = []
    items = list(merged_map.items())
    for idx, (ws, info) in enumerate(items):
        lines.append(ws + ":")
        lines.append("- name: " + info.get("name", ""))
        # tags 插在 name 之后、url1 之前（保持逻辑分组：元信息 → 网盘链接）
        tags_val = info.get("tags", "")
        if tags_val:
            lines.append("- tags: " + tags_val)
        lines.append("- url1: " + info.get("url1", ""))
        lines.append("- url2: " + info.get("url2", ""))
        lines.append("- url3: " + info.get("url3", ""))
        lines.append("- size: " + info.get("size", "0B"))
        # 条目之间空一行（末尾不追加多余空行，这里简单处理：除最后一条都加空行）
        if idx != len(items) - 1:
            lines.append("")

    # 末尾加换行
    content = "\n".join(lines) + "\n"

    with open(yml_path, "w", encoding="utf-8") as f:
        f.write(content)

    print("[OK] 写入完成: " + yml_path)


def sync_from_data(prefix):
    """
    合并前从 ../data/ 同步最新 {prefix}_pan.yml 到本目录（data_src/）。
    data/ 是 Hugo 实际读取、用户手工维护的版本（含 tags、LocalSend 等手工条目），
    以其为基准合并可避免在过时的 data_src/ 版本上丢失手工维护的数据。
    """
    src = os.path.join(BASE_DIR, "..", "data", prefix + "_pan.yml")
    dst = os.path.join(BASE_DIR, prefix + "_pan.yml")
    if os.path.exists(src):
        shutil.copy2(src, dst)
        print("[INFO] 已从 data/ 同步: " + os.path.basename(dst))
    else:
        print("[WARN] data/ 下不存在 %s，跳过同步" % os.path.basename(src))


def process_prefix(prefix, sources):
    """
    处理单个前缀组：同步 data/ 最新 yml → 读取 txt → 读已有 yml → 合并 → 写回
    sources 示例：{"baidu": ".../dst-baidu.txt", "quark": ".../dst-quark.txt"}
    """
    out_yml = os.path.join(BASE_DIR, prefix + "_pan.yml")
    print("\n========== 合并 %s ==========" % os.path.basename(out_yml))

    sync_from_data(prefix)  # 先同步 data/ 最新版本再合并
    baidu_map = parse_pan_txt(sources.get("baidu", ""))
    quark_map = parse_pan_txt(sources.get("quark", ""))
    existing = parse_existing_yml(out_yml)
    merged = merge_data(baidu_map, quark_map, existing)
    write_yml(out_yml, merged)


def main():
    """
    函数级入口：自动扫描所有前缀 → 逐个合并
    """
    groups = discover_prefixes()
    if not groups:
        print("[INFO] 未发现任何 txt 原料（命名需符合 {prefix}-baidu.txt / {prefix}-quark.txt）")
        return

    print("发现 %d 个前缀组: %s" % (len(groups), ", ".join(sorted(groups.keys()))))
    for prefix in sorted(groups.keys()):
        process_prefix(prefix, groups[prefix])

    print("\n========== 全部完成 ==========")


if __name__ == "__main__":
    main()
