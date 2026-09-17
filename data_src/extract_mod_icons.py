#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DST 模组主图标批量提取：压缩包 / 已解压目录 → 64x64 PNG
========================================================

扫描给定模组目录下的 `.zip`（或已解压的模组文件夹），从每个模组里找出「主图标」
（优先取 `modinfo.lua` 的 `icon` 声明，回退到 modicon.tex 等约定名），用
`static/files/ktex_tool.py` 解码 KTEX(.tex) 贴图，统一输出为 64x64 PNG，
文件名与站点约定一致：`static/img/ws/<WS编号>.png`
（见 `layouts/_shortcodes/dst-mods.html` 的 `data-img-base="/img/ws/"`）。

主图标定位优先级
----------------
    1. `modinfo.lua` 的 `icon` 声明（权威来源；本仓 45 个模组 100% 命中）
       - `icon_atlas` 若声明在子目录（如 `images/modicon.xml`），会一并尝试该目录
    2. 模组根目录的 `modicon.tex` / `modicon.png` / `mod_icon.*` / `icon.*`
    3. `images/` 下的同名文件
    4. 任意路径含 `icon` 的 `.tex` / `.png`（取路径最短者）
    5. 根目录下与同名 `.xml` 配对的 `.tex`（atlas 模式兜底）
    6. 全都找不到 → 直接输出 none.png（占位底图）

用 atlas xml 裁出「真实图标」
----------------------------
不少模组的 `modicon.tex` 其实是**图集**（一张大贴图里含多张图），真正的图标只是其中
一块矩形，边界写在 `icon_atlas` 指向的 `.xml` 里。所以解码后必须按 `<Element>` 的
u1/u2/v1/v2 裁剪，否则会把整张图集缩成 64x64，图标小得看不清。

    <Atlas>
      <Texture filename="modicon.tex"/>
      <Elements><Element name="modicon.tex" u1="0.0002" u2="0.6247" v1="0.3752" v2="0.9997"/></Elements>
    </Atlas>

坐标约定（已用 Skeletons Plus / 箱子的菜单 / 超级堆叠上限 实测校准）：
    * u1/u2 → 从左往右量（u=0 是左边）
    * v1/v2 → **从下往上**量（v=0 是底边、v=1 是顶边）
    * 换算到解码后「从上往下」的图像坐标：top=(1-v2)*H，bottom=(1-v1)*H

多元素图集（Elements 多于 1 个）时，优先取名字与 `icon` 同名的元素；实在匹配不上就
保留整图并打印 `!` 告警，绝不胡乱裁一块。

图片合成规则（`--size` 默认 64）
--------------------------------
始终**以 none.png 为底图**，把主图标缩放到 size×size 后直接整图叠加（左上角对齐）：

    * 图标不透明处覆盖底图，透明处露出底图的描边与底色
    * 没有主图标 → 直接输出 none.png 本身

用法
----
    # 默认：扫描目录下所有 zip，输出到 static/img/ws
    python data_src/extract_mod_icons.py -i "D:\\Desktop\\_pan\\模组DST\\260917"

    # 只预览每个模组会用哪个图标，不写文件
    python data_src/extract_mod_icons.py -i <目录> --dry-run

    # 已存在同名 PNG 时强制重新生成
    python data_src/extract_mod_icons.py -i <目录> --force

依赖（与 ktex_tool 相同）
------------------------
    pip install texture2ddecoder astc-encoder-py Pillow numpy
"""

from __future__ import annotations

# ---- 通用 UTF-8 铁律：PowerShell / 中文 Windows 下不因编码崩掉或乱码 ----
import sys

for _stream_name in ("stdin", "stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

import argparse
import re
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PIL import Image

# ---------- 路径与依赖 ----------

ROOT = Path(__file__).resolve().parents[1]          # hugo-book/
DEFAULT_OUTPUT = ROOT / "static" / "img" / "ws"     # 站点列表读图目录
KTEX_TOOL_DIR = ROOT / "static" / "files"           # ktex_tool.py 所在目录

if str(KTEX_TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(KTEX_TOOL_DIR))

try:
    import ktex_tool  # type: ignore
except Exception as exc:  # pragma: no cover
    print("[ERROR] 无法导入 ktex_tool（%s）" % exc)
    print("        请确认存在: %s" % (KTEX_TOOL_DIR / "ktex_tool.py"))
    raise SystemExit(2)

# 候选图标的扩展名（.tex 为 KTEX 贴图，.png 为普通图片）
ICON_EXTS = (".tex", ".png")

# 约定名（根目录 / images/ 下依次尝试）
CONVENTION_NAMES = ("modicon", "mod_icon", "icon", "preview", "modiconacc")

# modinfo.lua 中的图标声明：icon = "modicon.tex" / icon_atlas = "images/modicon.xml"
ICON_FIELD_RE = re.compile(r"""^\s*(icon|icon_atlas)\s*=\s*["']([^"']+)["']""", re.I)


# ---------- 模组来源抽象：zip 或目录 ----------

def _common_prefix(names: List[str]) -> str:
    """
    压平 zip 的顶层包裹目录。
    创意工坊下载的包通常是 `workshop-123456/...` 单一顶层目录，
    这里返回 `"workshop-123456/"`；若存在多个顶层或文件直接在根，则返回 ""。
    """
    tops = set()
    for n in names:
        if "/" in n:
            tops.add(n.split("/", 1)[0])
        else:
            return ""  # 有裸文件在根 → 不当作包裹
    if len(tops) == 1:
        return list(tops)[0] + "/"
    return ""


class ModSource:
    """
    一个模组：要么是 .zip 压缩包，要么是已解压的模组目录。

    统一对外提供「以模组根为基准的相对路径」，这样上层的图标查找逻辑
    不需要关心包裹目录、也不需要关心数据来自 zip 还是文件系统。
    """

    def __init__(self, path: Path):
        self.path = path
        self.is_zip = path.is_file()
        self._rel_to_entry: Dict[str, str] = {}
        self._text_cache: Dict[str, str] = {}

        if self.is_zip:
            with zipfile.ZipFile(path) as zf:
                entries = [i.filename for i in zf.infolist() if not i.is_dir()]
            prefix = _common_prefix(entries)
            for e in entries:
                self._rel_to_entry[e[len(prefix):]] = e
        else:
            for p in path.rglob("*"):
                if p.is_file():
                    rel = p.relative_to(path).as_posix()
                    self._rel_to_entry[rel] = rel

    # ---- 基本信息 ----

    @property
    def label(self) -> str:
        """输出 PNG 的文件名（不含扩展名）：优先 WS 编号，其次 workshop-数字，最后原名。"""
        name = self.path.name
        m = re.match(r"(?i)^(ws\s*\d{6,20})", name)
        if m:
            return re.sub(r"(?i)^ws\s*", "WS", m.group(1))
        m = re.search(r"(?i)workshop-(\d{6,20})", name)
        if m:
            return "WS" + m.group(1)
        return self.path.stem if self.is_zip else self.path.name

    def files(self) -> List[str]:
        """模组内所有文件的相对路径。"""
        return list(self._rel_to_entry.keys())

    # ---- 读取 ----

    def read_text(self, rel: str) -> str:
        """读取文本文件（用于 modinfo.lua）。"""
        if rel in self._text_cache:
            return self._text_cache[rel]
        data = self.read_bytes(rel)
        text = data.decode("utf-8", errors="replace")
        self._text_cache[rel] = text
        return text

    def read_bytes(self, rel: str) -> bytes:
        """读取文件字节。"""
        entry = self._rel_to_entry[rel]
        if self.is_zip:
            with zipfile.ZipFile(self.path) as zf:
                return zf.read(entry)
        return (self.path / entry).read_bytes()

    def materialize(self, rel: str, tmpdir: Path) -> Path:
        """
        取到一个可直接读取的真实文件路径。
        zip 内的文件会按需落盘到 tmpdir（只落目标图标这一个文件，不解压整包）。
        """
        entry = self._rel_to_entry[rel]
        if not self.is_zip:
            return self.path / entry
        dst = tmpdir / (Path(entry).name or "icon.tex")
        dst.write_bytes(self.read_bytes(rel))
        return dst


# ---------- 图标定位 ----------

def _flatten(files: List[str]) -> Dict[str, str]:
    """相对路径（转小写、/ 分隔）→ 原始相对路径，用于大小写不敏感查找。"""
    return {f.replace("\\", "/").lower(): f for f in files}


def _icon_candidates_from_modinfo(icon: str, atlas: str) -> List[str]:
    """
    由 modinfo.lua 的 icon / icon_atlas 推导候选相对路径（按优先级）。
    例：
        icon="modicon.tex", atlas="images/modicon.xml"
            → ["images/modicon.tex", "modicon.tex"]     ← atlas 在子目录时优先该目录
        icon="TMIR.tex",    atlas="TMIR.xml"
            → ["TMIR.tex"]
        icon="modicon"      （无扩展名）
            → ["modicon.tex", "modicon.png"]
    """
    out: List[str] = []
    icon = (icon or "").replace("\\", "/").lstrip("./")
    atlas = (atlas or "").replace("\\", "/").lstrip("./")

    # atlas 所在目录（若有）
    atlas_dir = atlas.rsplit("/", 1)[0] + "/" if "/" in atlas else ""

    def push(name: str) -> None:
        if not name:
            return
        if Path(name).suffix.lower() in ICON_EXTS:
            if name not in out:
                out.append(name)
        else:  # 没写扩展名，补全
            for ext in ICON_EXTS:
                cand = name + ext
                if cand not in out:
                    out.append(cand)

    if icon:
        if atlas_dir and "/" not in icon:
            push(atlas_dir + icon)      # 先试 atlas 目录
        push(icon)
    # icon 缺失但 atlas 有名字：用 atlas 同名的 .tex
    if not icon and atlas:
        push(Path(atlas).stem + ".tex")
    return out


def find_icon(src: ModSource) -> Tuple[Optional[str], str]:
    """
    返回 (图标的相对路径 或 None, 命中规则说明)。
    规则说明会打印在日志里，便于人工核对每个模组取的是哪张图。
    """
    files = src.files()
    lowered = _flatten(files)
    images = [f for f in files if f.lower().endswith(ICON_EXTS)]

    def match(rel: str) -> Optional[str]:
        return lowered.get(rel.replace("\\", "/").lower())

    # 1) modinfo.lua 的 icon / icon_atlas 声明（权威）
    for modinfo in (f for f in files if f.lower().endswith("modinfo.lua")):
        icon = atlas = ""
        for line in src.read_text(modinfo).splitlines():
            m = ICON_FIELD_RE.match(line)
            if not m:
                continue
            if m.group(1).lower() == "icon":
                icon = m.group(2).strip()
            else:
                atlas = m.group(2).strip()
        for cand in _icon_candidates_from_modinfo(icon, atlas):
            hit = match(cand)
            if hit:
                return hit, "modinfo:" + cand

    # 2) 根目录约定名 → 3) images/ 下约定名
    root_rel = {f.replace("\\", "/").lower(): f for f in images if "/" not in f.replace("\\", "/")}
    images_rel = {f.replace("\\", "/").lower(): f for f in images}
    for scope, table in (("root", root_rel), ("images", images_rel)):
        for stem in CONVENTION_NAMES:
            for ext in ICON_EXTS:
                key = (stem + ext) if scope == "root" else ("images/" + stem + ext)
                if key in table:
                    return table[key], "%s:%s" % (scope, key)

    # 4) 任意含 icon 的图片（取路径最短者，避免误取深层同名资源）
    fuzzy = sorted((f for f in images if "icon" in f.lower()), key=lambda s: (s.count("/"), len(s)))
    if fuzzy:
        return fuzzy[0], "fuzzy:" + fuzzy[0]

    # 5) 根目录下与同名 .xml 配对的 .tex（atlas 模式兜底）
    xml_stems = {Path(f).stem.lower() for f in files if f.lower().endswith(".xml") and "/" not in f.replace("\\", "/")}
    for f in images:
        rel = f.replace("\\", "/")
        if "/" not in rel and rel.lower().endswith(".tex") and Path(rel).stem.lower() in xml_stems:
            return f, "atlas-pair:" + rel

    return None, "none"


# ---------- atlas xml：切出真实图标 ----------

def parse_atlas_xml(text: str) -> Tuple[str, List[Tuple[str, float, float, float, float]]]:
    """
    解析 atlas xml，返回 (texture 文件名, [(element 名, u1, u2, v1, v2), ...])。
    解析失败或字段缺失时返回空值，由上层退回整图——不抛异常、不猜坐标。
    """
    try:
        root = ET.fromstring(text)
    except Exception:
        return "", []

    texture = ""
    for node in root.iter():
        if node.tag.lower().endswith("texture"):
            texture = (node.attrib.get("filename") or node.attrib.get("name") or "").strip()
            break

    elements: List[Tuple[str, float, float, float, float]] = []
    for node in root.iter():
        if not node.tag.lower().endswith("element"):
            continue
        attr = node.attrib
        try:
            u1 = float(attr.get("u1", 0.0))
            u2 = float(attr.get("u2", 1.0))
            v1 = float(attr.get("v1", 0.0))
            v2 = float(attr.get("v2", 1.0))
        except (TypeError, ValueError):
            continue
        elements.append((attr.get("name", ""), u1, u2, v1, v2))
    return texture, elements


def resolve_atlas(src: ModSource, icon_rel: str, files: List[str]) -> str:
    """
    找到该图标对应的 atlas xml（相对路径），找不到返回 ""。
    顺序：modinfo 的 icon_atlas → 与图标同目录同名的 .xml → 模组根目录同名的 .xml
    """
    lowered = _flatten(files)

    atlas = ""
    for modinfo in (f for f in files if f.lower().endswith("modinfo.lua")):
        for line in src.read_text(modinfo).splitlines():
            m = ICON_FIELD_RE.match(line)
            if m and m.group(1).lower() == "icon_atlas":
                atlas = m.group(2).strip().replace("\\", "/")
                break
        if atlas:
            break

    icon_dir = icon_rel.rsplit("/", 1)[0] + "/" if "/" in icon_rel else ""
    stem = Path(icon_rel).stem

    candidates: List[str] = []
    if atlas:
        candidates.append(atlas)
        if "/" not in atlas:                     # atlas 只写了文件名 → 也到图标目录找
            candidates.append(icon_dir + atlas)
    candidates.append(icon_dir + stem + ".xml")  # 图标同目录同名 xml
    candidates.append(stem + ".xml")             # 模组根目录同名 xml

    for cand in candidates:
        hit = lowered.get(cand.lower())
        if hit and hit.lower().endswith(".xml"):
            return hit
    return ""


def pick_element(elements: List[Tuple[str, float, float, float, float]], icon_rel: str):
    """从图集的多个 Element 里挑出图标对应的那个；只有一个就直接用；无法确定返回 None。"""
    if not elements:
        return None
    if len(elements) == 1:
        return elements[0]
    stem = Path(icon_rel).stem.lower()
    for want in (Path(icon_rel).name.lower(), stem + ".tex", stem, stem + ".png"):
        for elem in elements:
            if elem[0].lower() == want:
                return elem
    return None


def crop_by_element(img: Image.Image, elem) -> Tuple[Image.Image, Tuple[int, int, int, int]]:
    """
    按 atlas Element 裁出真实图标，返回 (裁剪后的图, 像素框 left/top/right/bottom)。
    坐标约定见模块 docstring：u 从左往右、v 从下往上（已实测校准）。
    """
    _, u1, u2, v1, v2 = elem
    W, H = img.size
    left = max(0, min(W - 1, int(round(min(u1, u2) * W))))
    right = max(left + 1, min(W, int(round(max(u1, u2) * W))))
    top = max(0, min(H - 1, int(round((1.0 - max(v1, v2)) * H))))
    bottom = max(top + 1, min(H, int(round((1.0 - min(v1, v2)) * H))))
    return img.crop((left, top, right, bottom)), (left, top, right, bottom)


# ---------- 解码与合成 ----------

def decode_icon(local_path: Path) -> Image.Image:
    """
    把 .tex(KTEX) 或 .png 解码成 RGBA 图像。
    .tex 走 ktex_tool；失败时抛出，由上层记录为错误项。
    """
    if local_path.suffix.lower() == ".tex":
        ktex = ktex_tool.read_ktex(str(local_path))
        rgba = ktex_tool.decode_ktex_to_rgba(ktex, level=0)
        return Image.fromarray(rgba, mode="RGBA")
    return Image.open(local_path).convert("RGBA")


def compose_icon(icon: Image.Image, base: Image.Image, size: int) -> Image.Image:
    """
    以 none.png 为底图，把图标缩放到 size×size 后直接整图叠加（左上角对齐）。

    图标的不透明部分覆盖底图，透明部分露出底图的描边与底色——主图标本来就是
    64x64，直接叠即可，不需要按内区缩放或居中。
    """
    canvas = base.convert("RGBA")
    if canvas.size != (size, size):
        canvas = canvas.resize((size, size), Image.LANCZOS)
    canvas = canvas.copy()

    icon = icon.convert("RGBA")
    if icon.size != (size, size):
        icon = icon.resize((size, size), Image.LANCZOS)
    canvas.alpha_composite(icon, (0, 0))
    return canvas


# ---------- 单个模组处理 ----------

def process_one(src: ModSource, out_dir: Path, base_img: Image.Image,
                size: int, force: bool, dry_run: bool) -> Dict[str, object]:
    """
    处理一个模组并写出 PNG，返回结果字典：
        {"label", "status", "rule", "entry", "note", "out"}
    status ∈ ok / fallback / error / skip
    """
    result: Dict[str, object] = {
        "label": src.label, "status": "error", "rule": "", "entry": "",
        "note": "", "warn": False, "out": out_dir / (src.label + ".png"),
    }
    out_path: Path = result["out"]  # type: ignore[assignment]

    if out_path.exists() and not force:
        result["status"] = "skip"
        result["note"] = "已存在（--force 可覆盖）"
        return result

    entry, rule = find_icon(src)
    result["rule"] = rule

    if entry is None:
        # 没有任何图标 → 直接用 none.png 当输出（占位）
        result["status"] = "fallback"
        result["note"] = "未找到主图标，输出 none.png"
        if not dry_run:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            base_img.save(out_path, "PNG", optimize=True)
        return result

    result["entry"] = entry
    try:
        with tempfile.TemporaryDirectory(prefix="modicon_") as td:
            local = src.materialize(entry, Path(td))
            icon = decode_icon(local)
            src_size = "%dx%d" % icon.size

            # 图集裁剪：不少 modicon.tex 其实是含多张图的大图集，
            # 真实图标只是其中一块矩形，边界写在 icon_atlas 指向的 xml 里。
            step = ""
            xml_rel = resolve_atlas(src, entry, src.files())
            if xml_rel:
                _texture, elements = parse_atlas_xml(src.read_text(xml_rel))
                result["rule"] = "%s + %s" % (rule, xml_rel)
                if not elements:
                    step = "  [xml 无 Element, 未裁剪]"
                    result["warn"] = True
                else:
                    elem = pick_element(elements, entry)
                    if elem is None:
                        # 多元素图集且名字对不上：宁可不裁，也不胡乱切一块
                        step = "  [!%d 个元素均未匹配, 未裁剪]" % len(elements)
                        result["warn"] = True
                    else:
                        icon, _box = crop_by_element(icon, elem)
                        step = "  裁%dx%d" % icon.size

            composed = compose_icon(icon, base_img, size)
            if not dry_run:
                out_path.parent.mkdir(parents=True, exist_ok=True)
                composed.save(out_path, "PNG", optimize=True)
        result["status"] = "ok"
        result["note"] = "%s%s → %dx%d" % (src_size, step, composed.width, composed.height)
    except Exception as exc:
        result["status"] = "error"
        result["note"] = "%s: %s" % (exc.__class__.__name__, exc)
    return result


# ---------- 批量入口 ----------

def collect_sources(input_path: Path) -> List[ModSource]:
    """
    收集待处理的模组：
      * 输入是 .zip → 只处理这一个
      * 输入是目录   → 递归找 *.zip，外加直接子目录中带 modinfo.lua 的（已解压模组）
    """
    if input_path.is_file():
        return [ModSource(input_path)]

    zips = sorted(input_path.rglob("*.zip"))
    folders = sorted(
        d for d in input_path.iterdir()
        if d.is_dir() and (d / "modinfo.lua").exists()
    )
    return [ModSource(p) for p in zips] + [ModSource(p) for p in folders]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="批量提取 DST 模组主图标 → 64x64 PNG（以 none.png 为底图）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("-i", "--input", required=True,
                        help="模组目录（递归找 zip 与已解压模组）或单个 zip")
    parser.add_argument("-o", "--output", default=str(DEFAULT_OUTPUT),
                        help="输出目录，默认 static/img/ws")
    parser.add_argument("--base", default="",
                        help="底图路径，默认取 <输出目录>/none.png")
    parser.add_argument("--size", type=int, default=64, help="输出边长，默认 64")
    parser.add_argument("--force", action="store_true", help="已存在同名 PNG 时覆盖")
    parser.add_argument("--dry-run", action="store_true", help="只报告命中情况，不写文件")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser()
    if not input_path.exists():
        print("[ERROR] 输入不存在: %s" % input_path)
        return 2
    out_dir = Path(args.output).expanduser()
    if not out_dir.is_absolute():
        out_dir = (ROOT / out_dir).resolve()

    base_path = Path(args.base).expanduser() if args.base else out_dir / "none.png"
    if not base_path.exists():
        print("[ERROR] 底图不存在: %s" % base_path)
        return 2
    base_img = Image.open(base_path).convert("RGBA")

    sources = collect_sources(input_path)
    if not sources:
        print("[WARN] 没有找到 .zip 或已解压的模组目录: %s" % input_path)
        return 1

    print("模板底图: %s (%dx%d) | 输出: %s | 尺寸: %d | 模组数: %d%s"
          % (base_path.name, base_img.width, base_img.height, out_dir, args.size,
             len(sources), "  [dry-run]" if args.dry_run else ""))
    print("-" * 100)

    results = []
    for idx, src in enumerate(sources, 1):
        r = process_one(src, out_dir, base_img, args.size, args.force, args.dry_run)
        results.append(r)
        if r["status"] != "skip" or args.dry_run:
            print("[%3d/%d] %-14s %-8s %-42s %s"
                  % (idx, len(sources), r["label"], r["status"],
                     str(r["rule"])[:42], r["note"]))
        else:
            print("[%3d/%d] %-14s %-8s %s" % (idx, len(sources), r["label"], "skip", r["note"]))

    ok = sum(1 for r in results if r["status"] == "ok")
    fb = sum(1 for r in results if r["status"] == "fallback")
    sk = sum(1 for r in results if r["status"] == "skip")
    er = [r for r in results if r["status"] == "error"]
    wn = [r for r in results if r.get("warn")]

    print("-" * 100)
    print("汇总: 成功 %d / 占位 %d / 跳过 %d / 失败 %d / 裁剪告警 %d"
          % (ok, fb, sk, len(er), len(wn)))
    for r in wn:
        print("  [告警] %s  %s  (%s)" % (r["label"], r["note"], r["entry"]))
    for r in er:
        print("  [失败] %s  %s  (%s)" % (r["label"], r["note"], r["entry"]))
    if not args.dry_run:
        print("输出目录: %s" % out_dir)
    return 1 if er else 0


if __name__ == "__main__":
    raise SystemExit(main())
