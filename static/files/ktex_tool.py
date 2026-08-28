"""
KTEX 贴图转换工具，支持 DXT5 / ASTC8x8 / ASTC6x6 格式。

免责：
    - 源码仅供学习参考，不建议用于生产环境。
    - 此工具非官方贴图工具，算法由 AI 分析游戏贴图文件而来，可能包含错误。

支持：
    - .tex (KTEX/BTEX) <-> .png        （解码 DXT5 / ASTC8x8 / ASTC6x6）
    - .tex <-> .tex                    （格式互转，可自动生成 mipmap 链）

依赖：
    pip install texture2ddecoder astc-encoder-py Pillow numpy

文件格式：
    magic='KTEX' + 4 字节压缩头 + mip 数据 (多无描述符)
    magic='KTEX' + 12 字节固定字段 + mip 描述符表 + mip 数据
"""

from __future__ import annotations

import argparse
import struct
import sys
import zipfile
import tempfile
import shutil
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image

try:
    from tqdm import tqdm  # type: ignore
    _HAS_TQDM = True
except Exception:  # pragma: no cover
    tqdm = lambda x, **kwargs: x  # type: ignore
    _HAS_TQDM = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

# ---------- 可选原生库 ----------
try:
    import texture2ddecoder as _t2d  # type: ignore
    _HAS_T2D = True
except Exception:  # pragma: no cover
    _t2d = None  # type: ignore
    _HAS_T2D = False

try:
    import astc_encoder as _astc  # type: ignore
    _HAS_ASTCENC = True
except Exception:  # pragma: no cover
    _astc = None  # type: ignore
    _HAS_ASTCENC = False


# ---------- 常量 ----------

MAGIC_KTEX = b"KTEX"   # 旧版 & 新版都用此 4 字节作为 magic

# 像素格式（KTEX 头中的 PixelFormat 字段）
FMT_DXT1 = 0
FMT_DXT5 = 2
FMT_ASTC8x8 = 24  # ASTC 8x8 压缩格式
FMT_ASTC6x6 = 25  # ASTC 6x6 压缩格式
FMT_ARGB = 4       # 未压缩 ARGB（每像素 4 字节: R,G,B,A）

FMT_NAMES = {
    FMT_DXT1: "DXT1",
    FMT_DXT5: "DXT5",
    FMT_ASTC8x8: "ASTC8x8",
    FMT_ASTC6x6: "ASTC6x6",
    FMT_ARGB: "ARGB",
}

# 每压缩块字节数和块尺寸
BLOCK_BYTES = {
    FMT_DXT1: 8,
    FMT_DXT5: 16,
    FMT_ASTC8x8: 16,
    FMT_ASTC6x6: 16,
    FMT_ARGB: 4,   # 每像素 4 字节（R,G,B,A）
}
BLOCK_SIZE = {
    FMT_DXT1: (4, 4),
    FMT_DXT5: (4, 4),
    FMT_ASTC8x8: (8, 8),
    FMT_ASTC6x6: (6, 6),
    FMT_ARGB: (1, 1),  # ARGB 未压缩，以像素为单位
}

# 用于自动检测格式的候选列表
CANDIDATE_FORMATS = [FMT_DXT1, FMT_DXT5, FMT_ASTC8x8, FMT_ASTC6x6, FMT_ARGB]

# 平台枚举
PLATFORM_PC = 12
PLATFORM_GENERIC = 0  # 通用/移动平台

# 纹理类型
TEX_TYPE_2D = 2
TEX_TYPE_2D_GENERIC = 1  # 通用 2D 纹理


# ---------- 数据结构 ----------

@dataclass
class KtexHeader:
    """KTEX 文件头（新版 24 字节，旧版 8 字节打包）。"""

    platform: int = PLATFORM_PC
    pixel_format: int = FMT_DXT5
    texture_type: int = TEX_TYPE_2D
    num_mips: int = 1
    flags: int = 1        # bit0: 有 mipmap
    remainder: int = 0

    def pack(self) -> bytes:
        """序列化为 24 字节新版头。"""
        d0 = self.platform & 0xFFFFFFFF
        d1 = self.pixel_format & 0xFFFFFFFF
        d2 = (
            (self.texture_type & 0xFFFF)
            | ((self.num_mips & 0xFF) << 16)
            | ((self.flags & 0x0F) << 24)
        )
        d3 = self.remainder & 0xFFFFFFFF
        return MAGIC_KTEX + struct.pack("<IIII", d0, d1, d2, d3)

    def pack_legacy(self) -> bytes:
        """序列化为 8 字节旧版头（5-bit pixel_format）。"""
        packed = (
            (self.platform & 0xF)
            | ((self.pixel_format & 0x1F) << 4)
            | ((self.texture_type & 0xF) << 9)
            | ((self.num_mips & 0x1F) << 13)
            | ((self.flags & 0x3) << 18)
            | ((self.remainder & 0xFFF) << 20)
        )
        return MAGIC_KTEX + struct.pack("<I", packed)

    @classmethod
    def unpack(cls, data: bytes) -> "KtexHeader":
        """
        从字节流解析头。

        新版 (24 字节):
            [0:4]   magic = b"KTEX"
            [4:8]   platform    (uint32)
            [8:12]  pixel_format (uint32)
            [12:16] texture_type | num_mips<<16 | flags<<24
            [16:20] remainder
            [20:24] 保留/填充

        旧版 (8 字节):
            [0:4]   magic = b"KTEX"
            [4:8]   32 位压缩: platform | fmt<<4 | type<<9 | mips<<13 | flags<<18 | rem<<20
        """
        if len(data) < 8:
            raise ValueError("文件过小，无法容纳 KTEX 头")
        if data[:4] != MAGIC_KTEX:
            raise ValueError(
                f"不是 Klei KTEX 文件 (magic 应为 {MAGIC_KTEX!r}，"
                f"实际为 {data[:4]!r})"
            )

        # 先尝试新版（需 >= 24 字节，且头部字段看起来合理）
        if len(data) >= 24:
            d0, d1, d2 = struct.unpack("<III", data[4:16])
            if (1 <= d0 <= 20) and (d1 in FMT_NAMES) and (1 <= (d2 & 0xFFFF) <= 16):
                return cls(
                    platform=d0,
                    pixel_format=d1,
                    texture_type=d2 & 0xFFFF,
                    num_mips=(d2 >> 16) & 0xFF,
                    flags=(d2 >> 24) & 0x0F,
                    remainder=0,
                )

        # 回退：旧版 8 字节压缩头
        # bit 0-3  : platform   (4 bit)
        # bit 4-8  : pixel_format (5 bit)
        # bit 9-12 : texture_type (4 bit)
        # bit 13-17: num_mips    (5 bit)
        # bit 18-19: flags       (2 bit)
        # bit 20-31: remainder   (12 bit)
        (packed,) = struct.unpack_from("<I", data, 4)
        platform = packed & 0xF
        pixel_format = (packed >> 4) & 0x1F
        texture_type = (packed >> 9) & 0xF
        num_mips = (packed >> 13) & 0x1F
        flags = (packed >> 18) & 0x3
        remainder = (packed >> 20) & 0xFFF
        return cls(
            platform=platform,
            pixel_format=pixel_format,
            texture_type=texture_type,
            num_mips=num_mips,
            flags=flags,
            remainder=remainder,
        )


@dataclass
class MipLevel:
    """单层 mip。"""

    width: int
    height: int
    data: bytes = b""

    @property
    def pitch(self) -> int:
        """压缩后的行字节数。"""
        bw, _ = BLOCK_SIZE[FMT_DXT5]  # pitch 与具体格式相关，这里保守按 4 块
        return _block_count(self.width, bw) * BLOCK_BYTES[FMT_DXT5]

    @property
    def data_size(self) -> int:
        return len(self.data)


@dataclass
class KtexFile:
    """一个完整的 KTEX 文件。"""

    header: KtexHeader = field(default_factory=KtexHeader)
    mips: List[MipLevel] = field(default_factory=list)


# ---------- 工具 ----------

def _block_count(size: int, block: int) -> int:
    """
    向上取整计算块数量。
    
    Args:
        size: 像素尺寸（宽或高）
        block: 块大小（如 DXT5 的 4，ASTC8x8 的 8）
    
    Returns:
        向上取整后的块数量
    """
    return max(1, (size + block - 1) // block)


def _mip_chain_dims(base_w: int, base_h: int, max_levels: int = 32) -> List[Tuple[int, int]]:
    """
    生成完整 mip 链尺寸列表，直到 1x1。
    
    Args:
        base_w: 基础宽度
        base_h: 基础高度
        max_levels: 最大 mip 层数
    
    Returns:
        mip 链尺寸列表，每个元素为 (width, height)
    """
    chain = []
    w, h = base_w, base_h
    for _ in range(max_levels):
        chain.append((w, h))
        if w == 1 and h == 1:
            break
        w = max(1, w // 2)
        h = max(1, h // 2)
    return chain


def _expected_mip_bytes(w: int, h: int, fmt: int) -> int:
    """
    根据尺寸和压缩格式计算一层 mip 占用的字节数。
    
    Args:
        w: 宽度
        h: 高度
        fmt: 像素格式常量
    
    Returns:
        该层 mip 的预期字节数
    """
    bw, bh = BLOCK_SIZE[fmt]
    return _block_count(w, bw) * _block_count(h, bh) * BLOCK_BYTES[fmt]


def _infer_main_size_from_total(total_bytes: int, fmt: int) -> Tuple[int, int, int]:
    """
    当文件没有 mip 描述符时，从主层数据字节数反推 (w, h)。
    
    使用扫描法：假设主层数据占据 total_bytes，尝试所有可能的 (w, h) 
    组合（向上取整到块大小），选取最接近正方形的组合。
    
    Args:
        total_bytes: 主层数据总字节数
        fmt: 像素格式常量
    
    Returns:
        (width, height) 尺寸元组
    
    Raises:
        ValueError: 无法推断主层尺寸时抛出
    """
    bw, bh = BLOCK_SIZE[fmt]
    bpb = BLOCK_BYTES[fmt]
    blocks = total_bytes // bpb
    best: Optional[Tuple[int, int, int]] = None
    for w in range(1, 4096):
        blocks_w = _block_count(w, bw)
        if blocks % blocks_w != 0:
            continue
        blocks_h = blocks // blocks_w
        h = blocks_h * bh
        if h < 1 or h > 4096:
            continue
        score = abs(w - h)
        cand = (score, w, h)
        if best is None or cand < best:
            best = cand
    if best is None:
        raise ValueError("无法推断主层尺寸")
    _, w, h = best
    return w, h


# ---------- 读取 / 写入 ----------

def read_ktex(path: str) -> KtexFile:
    """
    从磁盘读取 .tex 文件，自动识别头布局与 mip 结构。
    
    支持两种 KTEX 格式：
    1. 新版：24 字节头 + 交错 mip 描述符/数据
    2. 旧版：8 字节压缩头 + 连续 mip 描述符表 + 连续数据区
    
    自动检测像素格式，如果文件声明的格式与数据大小不匹配会重新检测。
    
    Args:
        path: .tex 文件路径
    
    Returns:
        KtexFile 对象，包含文件头和 mip 层数据
    
    Raises:
        ValueError: 文件格式无效或数据越界时抛出
    """
    raw = Path(path).read_bytes()

    if len(raw) >= 24:
        try:
            mips = _read_as_new_ktex(raw)
            if mips is not None:
                hdr = _parse_new_header(raw)
                hdr.num_mips = len(mips)
                hdr.flags = 1 if len(mips) > 1 else 0
                return KtexFile(header=hdr, mips=mips)
        except _FormatGuessFailed:
            pass

    hdr = KtexHeader.unpack(raw)
    
    hdr_size = 8
    n = hdr.num_mips
    if n <= 0 or n > 32:
        raise ValueError(f"num_mips={n} 超出合理范围")

    desc_off = hdr_size
    data_start = hdr_size + n * 10
    if data_start > len(raw):
        raise ValueError("文件过小，无法容纳 mip 描述符表")

    mips: List[MipLevel] = []
    cursor = data_start
    for i in range(n):
        w, h, _pitch, dsize = struct.unpack_from("<HHHI", raw, desc_off + i * 10)
        if w < 1 or h < 1 or dsize <= 0:
            raise ValueError(f"mip{i} 描述符异常：{w}x{h} dsize={dsize}")
        if cursor + dsize > len(raw):
            raise ValueError(f"mip{i} 数据越界：offset={cursor} dsize={dsize}")
        mips.append(MipLevel(width=w, height=h, data=raw[cursor : cursor + dsize]))
        cursor += dsize

    hdr.num_mips = len(mips)
    hdr.flags = 1 if len(mips) > 1 else 0
    ktex = KtexFile(header=hdr, mips=mips)
    
    needs_detect = False
    if hdr.pixel_format not in FMT_NAMES:
        needs_detect = True
    else:
        mip0 = mips[0]
        expected_size = _expected_data_size(mip0.width, mip0.height, hdr.pixel_format)
        if expected_size is not None and expected_size != len(mip0.data):
            needs_detect = True
    
    if needs_detect:
        detected_fmt = _detect_format(ktex)
        ktex.header.pixel_format = detected_fmt
    
    return ktex


def _expected_data_size(w: int, h: int, fmt: int) -> Optional[int]:
    """
    计算指定尺寸和格式的 mip 层应有字节数。
    
    Args:
        w: 宽度
        h: 高度
        fmt: 像素格式常量
    
    Returns:
        预期字节数，如果格式未知返回 None
    """
    bw, bh = BLOCK_SIZE.get(fmt, (4, 4))
    blocks_w = (w + bw - 1) // bw
    blocks_h = (h + bh - 1) // bh
    bpb = BLOCK_BYTES.get(fmt, 16)
    return blocks_w * blocks_h * bpb


class _FormatGuessFailed(Exception):
    """内部：新版布局解析失败时抛出。"""


def _parse_new_header(raw: bytes) -> KtexHeader:
    """
    按新版 24 字节头解析。
    
    Args:
        raw: 文件原始字节数据
    
    Returns:
        KtexHeader 对象
    """
    d0, d1, d2 = struct.unpack("<III", raw[4:16])
    return KtexHeader(
        platform=d0,
        pixel_format=d1,
        texture_type=d2 & 0xFFFF,
        num_mips=(d2 >> 16) & 0xFF,
        flags=(d2 >> 24) & 0x0F,
        remainder=0,
    )


def _read_as_new_ktex(raw: bytes) -> Optional[List[MipLevel]]:
    """
    尝试按新版布局解析；成功返回 mips 列表，失败返回 None。
    
    新版布局：24 字节头 + 交错的 mip 描述符(10字节)和数据
    
    Args:
        raw: 文件原始字节数据
    
    Returns:
        mips 列表，如果解析失败返回 None
    """
    if len(raw) < 24:
        return None
    d0, d1, d2 = struct.unpack("<III", raw[4:16])
    fmt = d1
    if fmt not in BLOCK_SIZE:
        return None
    num_mips = (d2 >> 16) & 0xFF
    if num_mips == 0 or num_mips > 32:
        return None

    offset = 24
    mips: List[MipLevel] = []
    for _ in range(num_mips):
        if offset + 10 > len(raw):
            return None
        w, h, _pitch, dsize = struct.unpack_from("<HHHI", raw, offset)
        if w < 1 or h < 1 or dsize <= 0:
            return None
        offset += 10
        if offset + dsize > len(raw):
            return None
        data = raw[offset : offset + dsize]
        offset += dsize
        mips.append(MipLevel(width=w, height=h, data=data))

    if offset != len(raw):
        return None
    return mips


def write_ktex(path: str, ktex: KtexFile) -> None:
    """
    将 KtexFile 写回磁盘（使用旧版 8 字节头 + 连续 mip 描述符 + 连续数据区）。
    
    Args:
        path: 输出文件路径
        ktex: KtexFile 对象
    """
    ktex.header.num_mips = len(ktex.mips)
    ktex.header.flags = 1 if len(ktex.mips) > 1 else 0
    buf = bytearray()
    buf += ktex.header.pack_legacy()
    for mip in ktex.mips:
        dsize = len(mip.data)
        bw, _ = BLOCK_SIZE.get(ktex.header.pixel_format, (4, 4))
        pitch = _block_count(mip.width, bw) * BLOCK_BYTES.get(ktex.header.pixel_format, 16)
        buf += struct.pack("<HHHI", mip.width, mip.height, pitch, dsize)
    for mip in ktex.mips:
        buf += mip.data
    Path(path).write_bytes(bytes(buf))


# ---------- 格式自动检测 ----------

def _detect_format(ktex: KtexFile) -> int:
    """
    自动检测 KtexFile 的实际压缩格式。
    
    如果有 texture2ddecoder 库，通过尝试用候选格式解码主层，
    检查输出是否包含有效数据来判断；否则根据数据大小推断。
    
    Args:
        ktex: KtexFile 对象
    
    Returns:
        检测到的像素格式常量
    """
    if not _HAS_T2D:
        mip = ktex.mips[0]
        data_size = len(mip.data)
        w, h = mip.width, mip.height
        astc_blocks_8 = _block_count(w, 8) * _block_count(h, 8)
        astc_blocks_6 = _block_count(w, 6) * _block_count(h, 6)
        if data_size == astc_blocks_8 * 16:
            return FMT_ASTC8x8
        if data_size == astc_blocks_6 * 16:
            return FMT_ASTC6x6
        dxt_blocks = _block_count(w, 4) * _block_count(h, 4)
        if data_size == dxt_blocks * 16:
            return FMT_DXT5
        return FMT_DXT5

    best_fmt = FMT_DXT5
    best_score = -1.0

    for fmt in CANDIDATE_FORMATS:
        try:
            mip = ktex.mips[0]
            rgba_bytes = _decode_mip_to_rgba_bytes(
                mip.data, mip.width, mip.height, fmt)
            arr = np.frombuffer(rgba_bytes, dtype=np.uint8)
            if arr.std() < 1.0:
                score = 0.0
            else:
                valid_pixels = np.sum((arr > 5) & (arr < 250))
                score = float(valid_pixels) / len(arr)
            if score > best_score:
                best_score = score
                best_fmt = fmt
        except Exception:
            continue

    return best_fmt


# ---------- 解码 ----------

def _decode_mip_to_rgba_bytes(data: bytes, w: int, h: int, fmt: int) -> bytes:
    """
    把任意格式的 mip 数据解码为 RGBA 原始字节（H*W*4）。
    
    对于压缩格式（DXT/ASTC）使用 texture2ddecoder，其返回 BGRA；
    对于未压缩 ARGB，数据本身就是 R,G,B,A 顺序，直接返回。
    
    Args:
        data: mip 层原始数据
        w: 宽度
        h: 高度
        fmt: 像素格式常量
    
    Returns:
        RGBA 原始字节，长度为 w * h * 4
    
    Raises:
        RuntimeError: 缺少 texture2ddecoder 依赖时抛出
        ValueError: 格式不支持时抛出
    """
    if fmt == FMT_ARGB:
        expected = w * h * 4
        if len(data) < expected:
            raise ValueError(
                f"ARGB 数据长度不足: 期望 {expected} 字节，实际 {len(data)} 字节"
            )
        return data[:expected]
    if not _HAS_T2D:
        raise RuntimeError(
            "缺少依赖 texture2ddecoder，请先执行: pip install texture2ddecoder"
        )
    if fmt == FMT_DXT1:
        bgra = _t2d.decode_bc1(data, w, h)
    elif fmt == FMT_DXT5:
        bgra = _t2d.decode_bc3(data, w, h)
    elif fmt == FMT_ASTC8x8:
        bgra = _t2d.decode_astc(data, w, h, 8, 8)
    elif fmt == FMT_ASTC6x6:
        bgra = _t2d.decode_astc(data, w, h, 6, 6)
    else:
        raise ValueError(f"未支持的像素格式: {FMT_NAMES.get(fmt, fmt)}")
    arr = np.frombuffer(bgra, dtype=np.uint8).reshape(h, w, 4)
    rgba = arr[:, :, [2, 1, 0, 3]].copy()
    return rgba.tobytes()


def decode_ktex_to_rgba(ktex: KtexFile, level: int = 0) -> np.ndarray:
    """
    解码指定 mip 层为 RGBA numpy 数组。
    
    Args:
        ktex: KtexFile 对象
        level: mip 层级，默认为 0（最高分辨率）
    
    Returns:
        RGBA numpy 数组，shape=(H, W, 4)，dtype=uint8
    
    Raises:
        IndexError: 指定的 mip 层不存在时抛出
    """
    if level >= len(ktex.mips):
        raise IndexError(f"mip 层 {level} 不存在 (共 {len(ktex.mips)} 层)")
    mip = ktex.mips[level]
    raw = _decode_mip_to_rgba_bytes(mip.data, mip.width, mip.height, ktex.header.pixel_format)
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(mip.height, mip.width, 4)
    rgba = np.flipud(arr).copy()
    return rgba


def ktex_to_png(path_tex: str, path_png: str, level: int = 0) -> None:
    """
    把 .tex 文件解码并保存为 .png。
    
    Args:
        path_tex: 输入 .tex 文件路径
        path_png: 输出 .png 文件路径
        level: 解码的 mip 层级，默认为 0
    """
    ktex = read_ktex(path_tex)
    rgba = decode_ktex_to_rgba(ktex, level=level)
    Image.fromarray(rgba, mode="RGBA").save(path_png, "PNG")


# ---------- 编码 ----------

def _encode_astc(rgba: np.ndarray, block_x: int = 8, block_y: int = 8) -> bytes:
    """
    使用 astc-encoder-py 将 RGBA 压缩为 ASTC 字节流。
    
    Args:
        rgba: RGBA numpy 数组，shape=(H, W, 4)，dtype=uint8
        block_x: ASTC 块宽度，默认为 8
        block_y: ASTC 块高度，默认为 8
    
    Returns:
        ASTC 压缩后的字节流
    
    Raises:
        RuntimeError: 缺少 astc-encoder-py 依赖时抛出
    """
    if not _HAS_ASTCENC:
        raise RuntimeError(
            "缺少依赖 astc-encoder-py，请先执行: pip install astc-encoder-py"
        )
    h, w = rgba.shape[:2]
    cfg = _astc.ASTCConfig(
        profile=_astc.ASTCProfile.LDR,
        block_x=block_x,
        block_y=block_y,
        quality=_astc.ASTCQualityPreset.MEDIUM,
    )
    ctx = _astc.ASTCContext(cfg)
    img = _astc.ASTCImage(
        data_type=_astc.ASTCType.U8,
        dim_x=w,
        dim_y=h,
        dim_z=1,
        data=rgba.tobytes(),
    )
    swizzle = _astc.ASTCSwizzle(
        r=_astc.ASTCSwizzleComponentSelector.R,
        g=_astc.ASTCSwizzleComponentSelector.G,
        b=_astc.ASTCSwizzleComponentSelector.B,
        a=_astc.ASTCSwizzleComponentSelector.A,
    )
    return ctx.compress(img, swizzle)


def _encode_dxt5_fallback(rgba: np.ndarray) -> bytes:
    """
    DXT5 纯 Python 压缩（优化实现）。
    
    使用改进的颜色选择算法：
    1. 对 Alpha 通道使用端点编码 + 插值
    2. 对 RGB 通道使用颜色空间最远点搜索 + 4 色插值
    
    Args:
        rgba: RGBA numpy 数组，shape=(H, W, 4)，dtype=uint8
    
    Returns:
        DXT5 压缩后的字节流
    """
    h, w = rgba.shape[:2]
    total_blocks = ((w + 3) // 4) * ((h + 3) // 4)
    out = bytearray(total_blocks * 16)

    bi = 0
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            block = rgba[by : by + 4, bx : bx + 4]
            bh, bw = block.shape[:2]

            # ----- Alpha 子块（8 字节）-----
            alphas = block[:, :, 3].ravel().astype(np.int32)
            a0 = int(alphas.min()) & 0xFF
            a1 = int(alphas.max()) & 0xFF
            if a0 == a1:
                a_bits = 0
            else:
                if a0 > a1:
                    a0, a1 = a1, a0
                a_indices = np.round((alphas - a0) * 7 / max(1, (a1 - a0)))
                a_indices = np.clip(a_indices, 0, 7).astype(np.uint8)
                a_bits = 0
                for i, v in enumerate(a_indices):
                    a_bits |= (int(v) & 0x07) << (i * 3)

            # ----- Color 子块（8 字节）-----
            rgb = block[:, :, :3].reshape(-1, 3).astype(np.int32)
            
            c0v, c1v = _find_best_endpoints(rgb)
            
            c0u = _rgb_to_565(c0v[0], c0v[1], c0v[2])
            c1u = _rgb_to_565(c1v[0], c1v[1], c1v[2])
            
            if c0u > c1u:
                c0u, c1u = c1u, c0u
                c0v, c1v = c1v, c0v
            
            colors = _generate_color_table(c0v, c1v)
            
            c_idx = _quantize_colors(rgb, colors)
            
            c_bits = 0
            for i, v in enumerate(c_idx):
                c_bits |= (int(v) & 0x03) << (i * 2)

            off = bi * 16
            out[off + 0] = a0
            out[off + 1] = a1
            a_val = int(a_bits) & 0xFFFFFFFFFFFF
            out[off + 2 : off + 8] = struct.pack("<Q", a_val)[:6]
            struct.pack_into("<HH", out, off + 8, c0u, c1u)
            c_val = int(c_bits) & 0xFFFFFFFF
            struct.pack_into("<I", out, off + 12, c_val)
            bi += 1

    return bytes(out)


def _find_best_endpoints(rgb: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """
    在颜色空间中找到最远的两个端点，用于 DXT 颜色编码。
    
    Args:
        rgb: RGB 像素数组，shape=(N, 3)，dtype=int32
    
    Returns:
        (c0, c1) 两个端点颜色数组
    """
    best_dist = 0
    best_i, best_j = 0, min(1, len(rgb) - 1)
    
    for i in range(len(rgb)):
        for j in range(i + 1, len(rgb)):
            diff = rgb[i] - rgb[j]
            dist = np.sum(diff * diff)
            if dist > best_dist:
                best_dist = dist
                best_i, best_j = i, j
    
    return rgb[best_i], rgb[best_j]


def _generate_color_table(c0: np.ndarray, c1: np.ndarray) -> np.ndarray:
    """
    根据两个端点生成 DXT 4 色插值表。
    
    Args:
        c0: 第一个端点颜色
        c1: 第二个端点颜色
    
    Returns:
        4x3 的颜色表 numpy 数组
    """
    colors = np.zeros((4, 3), dtype=np.int32)
    colors[0] = c0
    colors[1] = c1
    colors[2] = (2 * c0 + c1) // 3
    colors[3] = (c0 + 2 * c1) // 3
    return np.clip(colors, 0, 255)


def _quantize_colors(rgb: np.ndarray, colors: np.ndarray) -> np.ndarray:
    """
    将 RGB 像素量化到最近的颜色表条目。
    
    使用向量化操作替代逐像素循环，大幅提升性能。
    
    Args:
        rgb: RGB 像素数组，shape=(N, 3)
        colors: 颜色表，shape=(4, 3)
    
    Returns:
        每个像素的颜色索引，shape=(N,)
    """
    diff = rgb[:, np.newaxis, :] - colors[np.newaxis, :, :]
    dists = np.sum(diff * diff, axis=2)
    return np.argmin(dists, axis=1).astype(np.uint8)


def _rgb_to_565(r: int, g: int, b: int) -> int:
    """
    把 8-bit RGB 打包为 RGB565 16-bit。
    
    Args:
        r: 红色通道 (0-255)
        g: 绿色通道 (0-255)
        b: 蓝色通道 (0-255)
    
    Returns:
        RGB565 编码的 16-bit 值
    """
    r5 = (r * 31 + 127) // 255
    g6 = (g * 63 + 127) // 255
    b5 = (b * 31 + 127) // 255
    return (r5 << 11) | (g6 << 5) | b5


def _rgb565_split(c: int) -> Tuple[int, int, int]:
    """
    把 RGB565 拆成 (r, g, b) 8-bit。
    
    Args:
        c: RGB565 编码的 16-bit 值
    
    Returns:
        (r, g, b) 三元组，每个值范围 0-255
    """
    r = ((c >> 11) & 0x1F) * 255 // 31
    g = ((c >> 5) & 0x3F) * 255 // 63
    b = (c & 0x1F) * 255 // 31
    return r, g, b


def _encode_dxt1_fallback(rgba: np.ndarray) -> bytes:
    """DXT1 (BC1) 纯 Python 压缩。8 bytes/block, RGB + 1-bit alpha."""
    h, w = rgba.shape[:2]
    total_blocks = ((w + 3) // 4) * ((h + 3) // 4)
    out = bytearray(total_blocks * 8)

    bi = 0
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            block = rgba[by: by + 4, bx: bx + 4]
            rgb = block[:, :, :3].reshape(-1, 3).astype(np.int32)

            c0v, c1v = _find_best_endpoints(rgb)
            c0u = _rgb_to_565(int(c0v[0]), int(c0v[1]), int(c0v[2]))
            c1u = _rgb_to_565(int(c1v[0]), int(c1v[1]), int(c1v[2]))

            # DXT1: c0 must be > c1 for opaque mode
            if c0u <= c1u:
                c0u, c1u = c1u, c0u
                c0v, c1v = c1v, c0v

            colors = _generate_color_table(c0v, c1v)
            c_idx = _quantize_colors(rgb, colors)

            c_bits = 0
            for i, v in enumerate(c_idx):
                c_bits |= (int(v) & 0x03) << (i * 2)

            off = bi * 8
            struct.pack_into("<HH", out, off, c0u, c1u)
            struct.pack_into("<I", out, off + 4, int(c_bits) & 0xFFFFFFFF)
            bi += 1

    return bytes(out)


def _encode_argb(rgba: np.ndarray) -> bytes:
    """
    把 RGBA numpy 数组转为 ARGB 未压缩字节流（R,G,B,A 顺序）。
    
    这是游戏使用的原始未压缩格式，像素以 R,G,B,A 四字节顺序紧密排布。
    
    Args:
        rgba: RGBA numpy 数组，shape=(H, W, 4)，dtype=uint8
    
    Returns:
        ARGB 未压缩字节流
    """
    if not rgba.flags['C_CONTIGUOUS']:
        rgba = np.ascontiguousarray(rgba)
    return rgba.tobytes()


def _encode_rgba_to_ktex(
    rgba: np.ndarray,
    fmt: int,
    generate_mips: bool = True,
) -> KtexFile:
    """
    把 RGBA numpy 数组编码为 KtexFile（可自动生成 mipmap 链）。
    
    Args:
        rgba: RGBA numpy 数组，shape=(H, W, 4)，dtype=uint8
        fmt: 目标像素格式常量
        generate_mips: 是否自动生成 mipmap 链，默认为 True
    
    Returns:
        KtexFile 对象
    
    Raises:
        ValueError: 格式不支持时抛出
    """
    rgba_flipped = np.flipud(rgba)
    
    base_h, base_w = rgba_flipped.shape[:2]
    if generate_mips:
        chain = _mip_chain_dims(base_w, base_h)
    else:
        chain = [(base_w, base_h)]

    mips: List[MipLevel] = []
    pil_src = Image.fromarray(rgba_flipped, mode="RGBA")
    for i, (mw, mh) in enumerate(chain):
        if i == 0:
            img = rgba_flipped
        else:
            img = np.asarray(pil_src.resize((mw, mh), Image.BILINEAR), dtype=np.uint8)
        if fmt == FMT_ASTC8x8:
            data = _encode_astc(img, block_x=8, block_y=8)
        elif fmt == FMT_ASTC6x6:
            data = _encode_astc(img, block_x=6, block_y=6)
        elif fmt == FMT_DXT5:
            data = _encode_dxt5_fallback(img)
        elif fmt == FMT_DXT1:
            data = _encode_dxt1_fallback(img)
        elif fmt == FMT_ARGB:
            data = _encode_argb(img)
        else:
            raise ValueError(f"暂不支持编码格式: {FMT_NAMES.get(fmt, fmt)}")
        mips.append(MipLevel(width=mw, height=mh, data=data))
        if mw == 1 and mh == 1:
            break

    flags_val = 1 if len(mips) > 1 else 0
    remainder_val = 4095
    
    hdr = KtexHeader(
        platform=PLATFORM_GENERIC,
        pixel_format=fmt,
        texture_type=TEX_TYPE_2D_GENERIC,
        num_mips=len(mips),
        flags=flags_val,
        remainder=remainder_val,
    )
    return KtexFile(header=hdr, mips=mips)


def png_to_ktex(
    path_png: str,
    path_tex: str,
    fmt: int = FMT_ASTC8x8,
    generate_mips: bool = True,
) -> None:
    """
    把 .png 文件编码为 .tex 文件。
    
    Args:
        path_png: 输入 .png 文件路径
        path_tex: 输出 .tex 文件路径
        fmt: 目标像素格式，默认为 ASTC8x8
        generate_mips: 是否生成 mipmap 链，默认为 True
    
    Raises:
        FileNotFoundError: 输入文件不存在时抛出
        ValueError: 编码失败时抛出
    """
    try:
        img = Image.open(path_png).convert("RGBA")
    except FileNotFoundError:
        raise FileNotFoundError(f"输入文件不存在: {path_png}")
    except Exception as e:
        raise ValueError(f"无法打开 PNG 文件 {path_png}: {e}")
    
    rgba = np.array(img, dtype=np.uint8)
    
    try:
        ktex = _encode_rgba_to_ktex(rgba, fmt=fmt, generate_mips=generate_mips)
    except Exception as e:
        raise ValueError(f"编码失败 {path_png}: {e}")
    
    write_ktex(path_tex, ktex)


def convert_ktex(
    src_tex: str,
    dst_tex: str,
    dst_fmt: int,
    generate_mips: bool = True,
) -> None:
    """
    把一个 .tex 文件解码后重编码为另一种像素格式。
    
    Args:
        src_tex: 源 .tex 文件路径
        dst_tex: 目标 .tex 文件路径
        dst_fmt: 目标像素格式常量
        generate_mips: 是否生成 mipmap 链，默认为 True
    
    Raises:
        FileNotFoundError: 源文件不存在时抛出
        ValueError: 解码或编码失败时抛出
    """
    try:
        ktex = read_ktex(src_tex)
    except FileNotFoundError:
        raise FileNotFoundError(f"源文件不存在: {src_tex}")
    except Exception as e:
        raise ValueError(f"读取 KTEX 文件失败 {src_tex}: {e}")
    
    try:
        rgba = decode_ktex_to_rgba(ktex, level=0)
    except Exception as e:
        raise ValueError(f"解码失败 {src_tex}: {e}")
    
    try:
        new_ktex = _encode_rgba_to_ktex(
            rgba, fmt=dst_fmt, generate_mips=generate_mips
        )
    except Exception as e:
        raise ValueError(f"编码失败 {src_tex}: {e}")
    
    write_ktex(dst_tex, new_ktex)


# ---------- CLI ----------

def _normalize_fmt(name: str) -> int:
    """把命令行的格式名字映射为内部常量。"""
    key = name.strip().upper().replace(" ", "").replace("-", "")
    mapping = {
        "DXT1": FMT_DXT1, "BC1": FMT_DXT1,
        "DXT5": FMT_DXT5, "BC3": FMT_DXT5,
        "ASTC8X8": FMT_ASTC8x8, "ASTC_8X8": FMT_ASTC8x8, "ASTC": FMT_ASTC8x8,
        "ASTC6X6": FMT_ASTC6x6, "ASTC_6X6": FMT_ASTC6x6,
        "ARGB": FMT_ARGB,
    }
    if key not in mapping:
        raise argparse.ArgumentTypeError(
            f"未知格式 {name}，可选: dxt5 / astc8x8 / astc6x6 / argb"
        )
    return mapping[key]


# ---------- 批处理：扫描目录与 ZIP ----------

def _collect_files(root: Path, exts: set[str]) -> List[Path]:
    """
    递归收集目录下指定扩展名的文件。
    
    Args:
        root: 根目录或文件路径
        exts: 扩展名集合（如 {".tex", ".png"}）
    
    Returns:
        符合条件的文件路径列表
    """
    results: List[Path] = []
    if not root.exists():
        return results
    if root.is_file():
        if root.suffix.lower() in exts:
            results.append(root)
    else:
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in exts:
                results.append(p)
    return results


def _collect_zip_entries(root: Path, exts: set[str]) -> List[Tuple[Path, str]]:
    """
    扫描目录中所有 .zip 文件，返回 (zip路径, 内部成员名) 列表。
    
    Args:
        root: 根目录路径
        exts: 要收集的扩展名集合
    
    Returns:
        (ZIP路径, 成员名) 列表
    """
    results: List[Tuple[Path, str]] = []
    zip_files = _collect_files(root, {".zip"})
    for zpath in zip_files:
        try:
            with zipfile.ZipFile(zpath, "r") as zf:
                for name in zf.namelist():
                    if not name.endswith("/"):
                        suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
                        if suffix in exts:
                            results.append((zpath, name))
        except zipfile.BadZipFile as e:
            logger.warning(f"无法打开 ZIP {zpath}: {e}")
    return results


def _process_file(action: str, src: Path, dst: Path, fmt: int,
                  level: int, no_mips: bool) -> None:
    """
    根据 action 处理单个文件。
    
    Args:
        action: 操作类型，可选 tex2png/png2tex/convert
        src: 源文件路径
        dst: 目标文件路径
        fmt: 目标像素格式
        level: mip 层级
        no_mips: 是否禁用 mipmap 生成
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    if action == "tex2png":
        logger.info(f"[tex2png] {src} -> {dst}")
        ktex_to_png(str(src), str(dst), level=level)
    elif action == "png2tex":
        logger.info(f"[png2tex] {src} -> {dst}  (fmt={FMT_NAMES[fmt]})")
        png_to_ktex(str(src), str(dst), fmt=fmt, generate_mips=not no_mips)
    elif action == "convert":
        logger.info(f"[convert] {src} -> {dst}  (fmt={FMT_NAMES[fmt]})")
        convert_ktex(str(src), str(dst), dst_fmt=fmt, generate_mips=not no_mips)


def batch_process(action: str, paths: List[str], out_dir: Optional[str],
                  fmt: int = FMT_ASTC8x8, level: int = 0,
                  no_mips: bool = False) -> None:
    """
    批处理入口：支持传文件、文件夹或 ZIP 路径。
    
    - 原生文件：直接转换输出。
    - ZIP 中的 .tex：
        * tex2png: 解压转换，输出到同级 <zip>_out/
        * convert: 就地修改 ZIP 内的 .tex（写回原 ZIP）
        * png2tex: 解压处理，输出到同级 <zip>_out/
    
    Args:
        action: 操作类型，可选 tex2png/png2tex/convert
        paths: 输入路径列表，支持文件、文件夹或 ZIP
        out_dir: 输出目录，None 表示原地输出
        fmt: 目标像素格式，默认 ASTC8x8
        level: mip 层级，仅 tex2png 使用
        no_mips: 是否禁用 mipmap 生成
    """
    exts_in: set[str] = {".tex"} if action in ("tex2png", "convert") else {".png"}
    ext_out = ".png" if action == "tex2png" else ".tex"

    base_out = Path(out_dir) if out_dir else None

    native_files: List[Path] = []
    for p_str in paths:
        p = Path(p_str)
        if not p.exists():
            logger.warning(f"路径不存在，跳过: {p}")
            continue
        if p.is_file() and p.suffix.lower() in exts_in:
            native_files.append(p)
        elif p.is_dir():
            native_files.extend(_collect_files(p, exts_in))

    logger.info(f"找到 {len(native_files)} 个原生文件")
    failed = []
    for src in tqdm(native_files, desc=f"[{action.upper()}] 处理原生文件",
                    unit="file", disable=not _HAS_TQDM):
        dst_name = src.stem + ext_out
        if base_out:
            dst = base_out / dst_name
        else:
            dst = src.with_suffix(ext_out)
        try:
            _process_file(action, src, dst, fmt, level, no_mips)
        except Exception as e:
            logger.error(f"失败: {src} -> {e}")
            failed.append(str(src))
    if failed:
        logger.warning(f"{len(failed)} 个文件失败:\n" + "\n".join(failed))

    zip_entries: List[Tuple[Path, str]] = []
    seen_zips: set[Path] = set()
    for p_str in paths:
        p = Path(p_str)
        if not p.exists():
            continue
        if p.is_dir():
            for zpath in _collect_files(p, {".zip"}):
                if zpath not in seen_zips:
                    seen_zips.add(zpath)
                    zip_entries.extend(_collect_zip_file(zpath, exts_in))
        elif p.is_file() and p.suffix.lower() == ".zip":
            if p not in seen_zips:
                seen_zips.add(p)
                zip_entries.extend(_collect_zip_file(p, exts_in))

    logger.info(f"找到 {len(zip_entries)} 个 ZIP 内文件")
    if action == "convert":
        _process_zip_in_place(zip_entries, fmt, no_mips)
    else:
        for zpath, member in tqdm(zip_entries, desc=f"[{action.upper()}] 处理 ZIP 文件", 
                                  unit="file", disable=not _HAS_TQDM):
            try:
                with tempfile.TemporaryDirectory(prefix="tex_tool_") as tmp:
                    tmp_path = Path(tmp)
                    with zipfile.ZipFile(zpath, "r") as zf:
                        zf.extract(member, tmp_path)
                    extracted = tmp_path / member
                    if not extracted.exists():
                        continue
                    member_dir = Path(member).parent
                    stem = Path(member).stem
                    if base_out:
                        dst = base_out / (zpath.stem + "_out") / member_dir / (stem + ext_out)
                    else:
                        dst = zpath.parent / (zpath.stem + "_out") / member_dir / (stem + ext_out)
                    _process_file(action, extracted, dst, fmt, level, no_mips)
            except Exception as e:
                logger.error(f"处理 {zpath} 中 {member} 失败: {e}")


def _process_zip_in_place(
    zip_entries: List[Tuple[Path, str]],
    fmt: int,
    no_mips: bool,
) -> None:
    """
    将 ZIP 内的 .tex 文件就地转换为目标格式并写回原 ZIP。
    
    流程：
    1. 解压 ZIP 到临时目录
    2. 转换匹配的 .tex 文件
    3. 重新打包 ZIP
    4. 替换原 ZIP（使用 .tmp 原子替换）
    
    Args:
        zip_entries: (ZIP路径, 成员名) 列表
        fmt: 目标像素格式
        no_mips: 是否禁用 mipmap 生成
    """
    zip_members: dict[Path, List[str]] = {}
    for zpath, member in zip_entries:
        zip_members.setdefault(zpath, []).append(member)

    for zpath, members in zip_members.items():
        logger.info(f"\n[ZIP 转换] {zpath}")
        try:
            with tempfile.TemporaryDirectory(prefix="tex_tool_zip_") as tmp:
                tmp_path = Path(tmp)
                with zipfile.ZipFile(zpath, "r") as zf:
                    zf.extractall(tmp_path)

                for member in tqdm(members, desc=f"转换 {zpath.name}", 
                                   unit="file", disable=not _HAS_TQDM):
                    src = tmp_path / member
                    if not src.exists():
                        logger.warning(f"  [跳过] 不存在: {member}")
                        continue
                    logger.debug(f"  [convert] {member}  (fmt={FMT_NAMES[fmt]})")
                    ktex = read_ktex(str(src))
                    rgba = decode_ktex_to_rgba(ktex, level=0)
                    new_ktex = _encode_rgba_to_ktex(
                        rgba, fmt=fmt, generate_mips=not no_mips
                    )
                    write_ktex(str(src), new_ktex)

                tmp_zip = zpath.with_suffix(".zip.tmp")
                with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED) as new_zf:
                    for file_path in tmp_path.rglob("*"):
                        if file_path.is_file():
                            arcname = file_path.relative_to(tmp_path)
                            new_zf.write(file_path, arcname)

                tmp_zip.replace(zpath)
                logger.info(f"  [完成] 已写回: {zpath}")
        except Exception as e:
            logger.error(f"[错误] 处理 ZIP {zpath} 失败: {e}")
            try:
                tmp_zip = zpath.with_suffix(".zip.tmp")
                if tmp_zip.exists():
                    tmp_zip.unlink()
            except Exception:
                pass


def _collect_zip_file(zpath: Path, exts: set[str]) -> List[Tuple[Path, str]]:
    """
    从单个 ZIP 文件收集符合扩展名的成员。
    
    Args:
        zpath: ZIP 文件路径
        exts: 要收集的扩展名集合
    
    Returns:
        (ZIP路径, 成员名) 列表
    """
    results: List[Tuple[Path, str]] = []
    try:
        with zipfile.ZipFile(zpath, "r") as zf:
            for name in zf.namelist():
                if name.endswith("/"):
                    continue
                suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if suffix in exts:
                    results.append((zpath, name))
    except zipfile.BadZipFile as e:
        logger.warning(f"无法打开 ZIP {zpath}: {e}")
    return results


def print_info(path_str: str) -> None:
    """
    显示 .tex 文件或 .zip 文件的详细信息。
    
    对于 .tex 文件，显示头部参数和 mipmap 链详情。
    对于 .zip 文件，列出内部所有 .tex 文件的信息。
    对于目录，显示目录内所有 .tex 文件列表。
    
    Args:
        path_str: 文件或目录路径
    """
    p = Path(path_str)
    if not p.exists():
        logger.error(f"文件不存在: {p}")
        return
    
    if p.suffix.lower() == ".zip":
        _print_zip_info(p)
    elif p.suffix.lower() == ".tex":
        _print_tex_info(p)
    elif p.is_dir():
        _print_dir_info(p)
    else:
        logger.error(f"不支持的文件类型: {p.suffix}")
        logger.info("支持: .tex / .zip / 目录")


def _print_tex_info(path: Path) -> None:
    """
    显示单个 .tex 文件的详细信息。
    
    Args:
        path: .tex 文件路径
    """
    print(f"\n{'='*60}")
    print(f"TEX 文件信息: {path.name}")
    print(f"{'='*60}")
    print(f"文件大小: {path.stat().st_size:,} 字节")
    print()
    
    try:
        ktex = read_ktex(str(path))
    except Exception as e:
        print(f"读取失败: {e}")
        return
    
    hdr = ktex.header
    print("【头部参数】")
    print(f"  platform:        {hdr.platform}  (0=Generic, 12=PC)")
    print(f"  pixel_format:    {hdr.pixel_format}  ({FMT_NAMES.get(hdr.pixel_format, '未知')})")
    print(f"  texture_type:    {hdr.texture_type}  (1=通用2D, 2=2D)")
    print(f"  num_mips:        {hdr.num_mips}")
    print(f"  flags:           {hdr.flags:02b}  (bit0=mipmap, bit1=sRGB)")
    print(f"  remainder:       {hdr.remainder}  (0xFFF=保留)")
    print()
    
    print("【Mipmap 链】")
    print(f"  {'层':<4} {'尺寸':<14} {'块数':<16} {'stride':<10} {'数据大小':<12} {'状态'}")
    print(f"  {'─'*4} {'─'*14} {'─'*16} {'─'*10} {'─'*12} {'─'*6}")
    
    total_size = 0
    for i, mip in enumerate(ktex.mips):
        bw, bh = BLOCK_SIZE.get(hdr.pixel_format, (4, 4))
        bpb = BLOCK_BYTES.get(hdr.pixel_format, 16)
        blocks_w = (mip.width + bw - 1) // bw
        blocks_h = (mip.height + bh - 1) // bh
        stride = blocks_w * bpb
        expected = blocks_w * blocks_h * bpb
        match = "OK" if expected == len(mip.data) else "FAIL"
        
        size_str = f"{mip.width}x{mip.height}"
        blocks_str = f"{blocks_w}x{blocks_h}={blocks_w*blocks_h}"
        data_str = f"{len(mip.data):,}B"
        
        print(f"  {i:<4} {size_str:<14} {blocks_str:<16} {stride:<10} {data_str:<12} {match}")
        total_size += len(mip.data)
    
    print(f"\n  总数据大小: {total_size:,} 字节")
    
    if ktex.mips:
        mip0 = ktex.mips[0]
        print(f"\n【主贴图】{mip0.width}x{mip0.height}")
        
        # 计算像素数和理论压缩比
        raw_size = mip0.width * mip0.height * 4  # RGBA 每像素 4 字节
        if raw_size > 0:
            ratio = (1 - len(mip0.data) / raw_size) * 100
            print(f"  原始 RGBA 大小: {raw_size:,} 字节")
            print(f"  压缩后大小:     {len(mip0.data):,} 字节")
            print(f"  压缩率:         {ratio:.1f}%")


def _print_zip_info(path: Path) -> None:
    """
    显示 .zip 文件内所有 .tex 文件的信息。
    
    Args:
        path: .zip 文件路径
    """
    print(f"\n{'='*60}")
    print(f"ZIP 文件信息: {path.name}")
    print(f"{'='*60}")
    print(f"文件大小: {path.stat().st_size:,} 字节")
    print()
    
    try:
        with zipfile.ZipFile(path, "r") as zf:
            infos = zf.infolist()
            tex_infos = [i for i in infos if i.filename.lower().endswith(".tex")]
            
            print(f"ZIP 内文件总数: {len(infos)}")
            print(f"其中 .tex 文件: {len(tex_infos)}")
            print()
            
            if not tex_infos:
                print("ZIP 内没有 .tex 文件")
                return
            
            print("【TEX 文件列表】")
            for i, info in enumerate(tex_infos):
                print(f"  {i+1}. {info.filename}")
                print(f"     压缩大小: {info.compress_size:,} 字节")
                print(f"     原始大小: {info.file_size:,} 字节")
            print()
            
            # 解压并分析每个 .tex
            with tempfile.TemporaryDirectory(prefix="tex_info_") as tmp:
                for info in tex_infos:
                    print(f"分析: {info.filename}")
                    zf.extract(info, tmp)
                    extracted = Path(tmp) / info.filename
                    if extracted.exists():
                        _print_tex_info(extracted)
                        print()
    except Exception as e:
        print(f"读取 ZIP 失败: {e}")


def _print_dir_info(path: Path) -> None:
    """
    显示目录内所有 .tex 文件的信息。
    
    Args:
        path: 目录路径
    """
    tex_files = list(path.rglob("*.tex"))
    print(f"\n目录: {path}")
    print(f"找到 {len(tex_files)} 个 .tex 文件")
    
    for tf in tex_files[:20]:  # 最多显示 20 个
        print(f"  - {tf.relative_to(path)}")
    
    if len(tex_files) > 20:
        print(f"  ... 还有 {len(tex_files) - 20} 个文件")
    
    if tex_files:
        print(f"\n分析第一个文件:")
        _print_tex_info(tex_files[0])


# ---------- 交互式菜单 ----------

def _prompt(prompt: str, default: str = "") -> str:
    """
    在交互式菜单中读取用户输入。
    
    Args:
        prompt: 提示信息
        default: 默认值（为空时不显示）
    
    Returns:
        用户输入值（若为空则返回默认值）
    """
    suffix = f" [{default}]" if default else ""
    try:
        val = input(f"{prompt}{suffix}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        raise
    return val or default


# 快捷指令映射
_QUICK_MAP = {
    "1":    "tex2png",
    "2":    "png2tex",
    "3":    "convert",
    "4":    "info",
    "decode": "tex2png",
    "encode": "png2tex",
    "info":   "info",
    "d":    "tex2png",
    "e":    "png2tex",
    "c":    "convert",
    "i":    "info",
}


def run_interactive() -> int:
    """
    启动交互式菜单，引导用户完成贴图转换操作。
    
    用户可以选择 tex2png/png2tex/convert/info 操作，
    输入文件/目录/ZIP 路径，设置输出目录和格式参数。
    
    Returns:
        0 表示成功，非零表示失败
    """
    print("=" * 50)
    print("   KTEX 贴图转换工具  (DXT5 / ASTC8x8 / ASTC6x6 / ARGB)")
    print("=" * 50)
    print()
    print("支持的操作:")
    print("  1) tex2png  —  .tex -> .png   (解码贴图)")
    print("  2) png2tex  —  .png -> .tex   (编码贴图)")
    print("  3) convert  —  .tex -> .tex   (格式互转)")
    print("  4) info     —  显示 .tex/.zip 详细信息")
    print()
    print("可输入: 文件 / 文件夹 / .zip (ZIP 会自动解压处理内部 .tex)")
    print()

    # 选择操作（支持快捷指令：1/2/3/4 / d/e/c/i / decode/encode/info）
    action_choice = _prompt("请选择操作 [1/2/3/4]", "1").lower()
    action = _QUICK_MAP.get(action_choice)
    if action is None:
        print("无效选择")
        return 1

    # 输入路径
    paths_str = _prompt("输入文件/文件夹/zip 路径（多个用逗号分隔）")
    if not paths_str:
        print("未输入路径")
        return 1
    paths = [p.strip().strip('"') for p in paths_str.split(",") if p.strip()]

    # 输出目录（info 命令不需要）
    out_dir = ""
    if action != "info":
        out_dir = _prompt(
            "输出目录（留空=原地，ZIP输出到同级 <zip>_out）", "")

    # 格式（仅编码/转换时）
    fmt = FMT_ARGB
    no_mips = False
    if action in ("png2tex", "convert"):
        print()
        print("可选格式:")
        print("  1) argb       通用格式 (未压缩)")
        print("  2) dxt5       DST电脑版 (BC3)")
        print("  3) astc8x8    DST手机版 (推荐)")
        print("  4) astc6x6    DST手机版 (备用)")
        print()
        fmt_choice = _prompt("选择格式编号", "1")
        fmt_map = {"1": FMT_ARGB, "2": FMT_DXT5,
                   "3": FMT_ASTC8x8, "4": FMT_ASTC6x6}
        if fmt_choice not in fmt_map:
            print("无效格式选择")
            return 1
        fmt = fmt_map[fmt_choice]
        gen_mips = _prompt("生成 mipmap 链? [Y/n]", "y").lower() != "n"
        no_mips = not gen_mips

    # mip 层（仅解码时）
    level = 0
    if action == "tex2png":
        lv_str = _prompt("解码的 mip 层 [数字]", "0")
        try:
            level = int(lv_str)
        except ValueError:
            level = 0

    print()
    print("-" * 50)
    print(f"操作    : {action}")
    print(f"路径    : {paths}")
    if action != "info":
        print(f"输出目录: {out_dir or '(原地)'}")
    if action in ("png2tex", "convert"):
        print(f"目标格式: {FMT_NAMES[fmt]}  (mipmap={'off' if no_mips else 'on'})")
    if action == "tex2png":
        print(f"mip 层  : {level}")
    print("-" * 50)
    print()

    try:
        if action == "info":
            for p in paths:
                print_info(p)
        else:
            batch_process(action, paths, out_dir or None,
                          fmt=fmt, level=level, no_mips=no_mips)
    except Exception as e:
        print(f"\n错误: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1
    print("\n完成 ✓")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    """
    命令行入口函数。
    
    无参数时自动进入交互菜单，有参数时解析命令行参数执行对应操作。
    
    Args:
        argv: 命令行参数列表（默认为 sys.argv[1:]）
    
    Returns:
        0 表示成功，非零表示失败
    """
    # 无任何参数 -> 直接启动菜单
    if argv is None:
        argv = sys.argv[1:]
    if len(argv) == 0:
        return run_interactive()

    parser = argparse.ArgumentParser(
        prog="tex_tool",
        description="KTEX 贴图转换工具 (DXT5 / ASTC8x8 / ASTC6x6 / ARGB)",
    )
    parser.add_argument("-i", "--interactive", action="store_true",
                        help="启动交互式菜单")
    sub = parser.add_subparsers(dest="action")

    p1 = sub.add_parser("tex2png", help="把 .tex 解码为 .png")
    p1.add_argument("inputs", nargs="+", help="一个或多个文件/目录/zip")
    p1.add_argument("-o", "--output", help="输出目录（默认同目录）")
    p1.add_argument("--level", type=int, default=0, help="解码的 mip 层，默认 0")
    p1.add_argument("--batch", action="store_true",
                    help="启用批处理：递归扫描目录 / 处理 zip")

    p2 = sub.add_parser("png2tex", help="把 .png 编码为 .tex")
    p2.add_argument("inputs", nargs="+", help="一个或多个文件/目录/zip")
    p2.add_argument("-f", "--format", default="argb",
                    help="目标格式 argb/dxt1/dxt3/dxt5/astc8x8 (默认 argb)")
    p2.add_argument("--no-mips", action="store_true", help="不生成 mipmap 链")
    p2.add_argument("-o", "--output", help="输出目录（默认同目录）")
    p2.add_argument("--batch", action="store_true",
                    help="启用批处理：递归扫描目录 / 处理 zip")

    p3 = sub.add_parser("convert", help="在 .tex 之间做格式转换")
    p3.add_argument("inputs", nargs="+", help="一个或多个文件/目录/zip")
    p3.add_argument("-f", "--format", default="argb",
                    help="目标格式 argb/dxt1/dxt3/dxt5/astc8x8")
    p3.add_argument("--no-mips", action="store_true", help="不生成 mipmap 链")
    p3.add_argument("-o", "--output", help="输出目录")
    p3.add_argument("--batch", action="store_true",
                    help="启用批处理：递归扫描目录 / 处理 zip")

    p4 = sub.add_parser("info", help="显示 .tex / .zip 文件详细信息")
    p4.add_argument("inputs", nargs="+", help="一个或多个 .tex / .zip / 目录")

    args = parser.parse_args(argv)

    # 无参数 -> 交互菜单
    if args.interactive or (args.action is None):
        if args.action is None and not args.interactive and len(sys.argv) > 1:
            # 仅有 -i 以外的参数但没指定 action，显示帮助
            parser.print_help()
            return 1
        return run_interactive()

    # info 命令不需要 output/batch 等参数
    if args.action == "info":
        for inp in args.inputs:
            print_info(inp)
        return 0

    out_dir = Path(args.output) if args.output else Path('out')
    out_dir.mkdir(parents=True, exist_ok=True)

    # 智能批处理：如果输入包含目录或 zip，自动启用批处理模式
    has_dir_or_zip = any(
        Path(p).is_dir() or Path(p).suffix.lower() == ".zip"
        for p in args.inputs
    )

    try:
        if args.batch or has_dir_or_zip:
            if has_dir_or_zip and not args.batch:
                logger.info("[自动] 检测到目录/ZIP 输入，启用批处理模式")
            fmt = _normalize_fmt(args.format) if args.action != "tex2png" else FMT_ASTC8x8
            batch_process(
                args.action, args.inputs, args.output,
                fmt=fmt,
                level=getattr(args, "level", 0),
                no_mips=getattr(args, "no_mips", False),
            )
        elif args.action == "tex2png":
            for inp in args.inputs:
                src = Path(inp)
                dst = out_dir / (src.stem + ".png") if out_dir else src.with_suffix(".png")
                logger.info(f"[tex2png] {src} -> {dst}")
                ktex_to_png(str(src), str(dst), level=args.level)

        elif args.action == "png2tex":
            fmt = _normalize_fmt(args.format)
            for inp in args.inputs:
                src = Path(inp)
                dst = out_dir / (src.stem + ".tex") if out_dir else src.with_suffix(".tex")
                logger.info(f"[png2tex] {src} -> {dst}  (fmt={FMT_NAMES[fmt]})")
                png_to_ktex(str(src), str(dst), fmt=fmt,
                            generate_mips=not args.no_mips)

        elif args.action == "convert":
            fmt = _normalize_fmt(args.format)
            for inp in args.inputs:
                src = Path(inp)
                dst = out_dir / (src.stem + ".tex") if out_dir else src.with_suffix(".tex")
                logger.info(f"[convert] {src} -> {dst}  (fmt={FMT_NAMES[fmt]})")
                convert_ktex(str(src), str(dst), dst_fmt=fmt,
                             generate_mips=not args.no_mips)

        elif args.action == "info":
            for inp in args.inputs:
                print_info(inp)

    except FileNotFoundError as e:
        logger.error(f"文件不存在：{e}")
        return 2
    except ValueError as e:
        logger.error(f"参数错误：{e}")
        return 3
    except Exception as e:
        logger.error(f"执行失败：{e}")
        logger.debug("详细错误信息:", exc_info=True)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
