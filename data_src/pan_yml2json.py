# -*- coding: utf-8 -*-
"""
pan yml → json 转换脚本
------------------------
自动扫描脚本所在目录下所有 `{prefix}_pan.yml`（如 dst_pan.yml / ds_pan.yml），
将其直接转换为同目录下的 `{prefix}_pan.json`。

转换规则（“直接转”）：
    源 yml 条目：
        WS000000:
        - name: 手游优化
        - tags: 优化
        - url1: https://...
        - url2: https://pan.xunlei.com
        - url3: https://...
        - size: 182.40KB
    转成 json（条目内的 - 字段合并为单个对象，key 顺序不变）：
        "WS000000": {
            "name": "手游优化",
            "tags": "优化",
            "url1": "https://...",
            "url2": "https://pan.xunlei.com",
            "url3": "https://...",
            "size": "182.40KB"
        }

说明：
* 顶层 key（LocalSend / 游戏 / WSxxx 等）与字段顺序均按文件原样保留。
* 编码一律 utf-8；JSON 输出不转义中文（ensure_ascii=False），便于阅读。
* 不依赖 PyYAML，纯文本解析（与 merge_pans.py 中 parse_existing_yml 相同思路）。

用法：
    python pan_yml2json.py                 # 转换目录下全部 *_pan.yml
    python pan_yml2json.py dst_pan.yml     # 只转换指定文件
"""

import json
import os
import re
import sys
from collections import OrderedDict

# ---------- 路径配置 ----------
# 脚本与待转换 yml 均放在 hugo-book/data_src/ 同一目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 顶层 key 行：行首无缩进 + 以 ":" 结尾（key 本身不含 ":"，避免把 "http:" 当 key）
KEY_RE = re.compile(r"^(?P<key>[^:\s-][^:]*):\s*$")
# - 字段行：- name: value / - url1: value ...（通用，任何 field: value）
FIELD_RE = re.compile(r"^\s*-\s*(?P<k>[A-Za-z0-9_]+):\s*(?P<v>.*?)\s*$")


def parse_yml(yml_path):
    """
    解析 pan yml 为 OrderedDict：
        { key: { field: value, ... } }，key 与 field 顺序均保持原样。
    """
    result = OrderedDict()
    if not os.path.exists(yml_path):
        print("[WARN] 文件不存在，跳过: " + yml_path)
        return result

    with open(yml_path, "r", encoding="utf-8") as f:
        lines = [ln.rstrip("\r\n") for ln in f.readlines()]

    cur_key = None
    cur_item = None

    def flush():
        """把当前累积的条目写入 result"""
        if cur_key is not None and cur_item is not None:
            result[cur_key] = cur_item

    for ln in lines:
        if ln.strip() == "":
            continue  # 跳过空行 / 注释
        if ln.lstrip().startswith("#"):
            continue  # 跳过注释行
        m_key = KEY_RE.match(ln)
        if m_key:
            flush()
            cur_key = m_key.group("key").strip()
            cur_item = OrderedDict()
            continue
        m_field = FIELD_RE.match(ln)
        if m_field and cur_item is not None:
            cur_item[m_field.group("k")] = m_field.group("v")

    flush()
    return result


def convert_file(yml_path):
    """把单个 yml 转成同名 json，返回 (条目数, 输出路径)"""
    data = parse_yml(yml_path)
    json_path = os.path.splitext(yml_path)[0] + ".json"

    # ensure_ascii=False 保留中文；indent=2 便于阅读；末尾补换行
    with open(json_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2))
        f.write("\n")

    print("[INFO] %s → %s （%d 条）" % (os.path.basename(yml_path),
                                       os.path.basename(json_path), len(data)))
    return len(data), json_path


def main():
    # 命令行可指定要转换的文件名；不指定则自动扫描目录下全部 *_pan.yml
    targets = [a for a in sys.argv[1:] if a.endswith(".yml")]
    if not targets:
        for fname in os.listdir(BASE_DIR):
            if fname.endswith("_pan.yml"):
                targets.append(fname)

    if not targets:
        print("[WARN] 未找到 *_pan.yml 文件")
        return

    total = 0
    for fname in targets:
        yml_path = fname if os.path.isabs(fname) else os.path.join(BASE_DIR, fname)
        if not os.path.exists(yml_path):
            print("[WARN] 文件不存在，跳过: " + yml_path)
            continue
        n, _ = convert_file(yml_path)
        total += n

    print("\n总计转换 %d 条记录" % total)


if __name__ == "__main__":
    main()
