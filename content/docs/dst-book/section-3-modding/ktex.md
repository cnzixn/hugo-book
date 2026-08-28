---
title: "KTEX 工具的简单实现"
bookHidden: true
weight: 100
aliases:
  - "/p/ktex"
---

# KTEX 工具的简单实现

> 文件：[ktex_tool.py](/files/ktex_tool.py) | 适用：DST 手机版贴图 ASTC 压缩格式

---

## 1. ASTC 是什么

ASTC（Adaptive Scalable Texture Compression）是 ARM 主导的移动 GPU 标准纹理压缩格式。
与其他固定算法（DXT/BC）最大的区别：**每个 16 字节块内部是自适应编码**——分区数、
颜色端点数、比特分配都由块内容决定，块数据自描述，解码器按块解析。

DST 手机版使用两种 ASTC 变体：

| 格式 | KTEX 格式码 | 块尺寸 | 块字节数 | 每像素比特 | 压缩率(对 RGBA32) |
|------|------------|--------|---------|-----------|------------------|
| ASTC 8x8 | `24` | 8×8=64 像素 | 16 | 2.0 bpp | **6.25%**（1/16） |
| ASTC 6x6 | `25` | 6×6=36 像素 | 16 | 3.56 bpp | 11.1% |

8x8 体积最小、画质最低，是手游贴图首选；6x6 画质更高，作为备用。

## 2. KTEX 容器中的 ASTC

```
新版文件: [KTEX 24字节头] + { [10字节mip描述符][压缩数据] } × N   （描述符与数据交错）
旧版文件: [KTEX 8字节压缩头] + [10字节描述符表 × N] + [数据 × N]  （表与数据分离）
```

- 头部 `pixel_format` 字段：`24`=ASTC8x8，`25`=ASTC6x6（[L73-74](ktex_tool.py#L73-L74)）
- mip 描述符（10 字节）：`<HHHI` = width, height, pitch, data_size
- 工具**写出**时统一用旧版 8 字节头 + 连续布局（`pack_legacy`，[L138-148](ktex_tool.py#L138-L148)）
- 读取时先试新版布局（`_read_as_new_ktex`，[L454-493](ktex_tool.py#L454-L493)），失败回退旧版

## 3. 数据大小计算（核心公式）

```python
blocks_w = ceil(w / block_x)          # 向上取整，不满一块按一块算（L241-252）
blocks_h = ceil(h / block_y)
mip_bytes = blocks_w * blocks_h * 16  # ASTC 每块恒定 16 字节（L278-291）
```

ASTC 支持任意非 2 次幂尺寸——不像 DXT 需要对齐，这是手机版选它的另一个原因。

## 4. 解码流程（ASTC → RGBA）

入口 `_decode_mip_to_rgba_bytes`（[L573-616](ktex_tool.py#L573-L616)）：

```
.tex 数据 ──texture2ddecoder.decode_astc(data, w, h, 8/6, 8/6)──▶ BGRA 缓冲
        ──numpy 通道重排 arr[:,:,[2,1,0,3]]──▶ RGBA
        ──np.flipud()──▶ 最终图像（KTEX 数据自底向上存储）
```

关键点：
- `texture2ddecoder` 输出 **BGRA** 顺序，必须 swizzle 成 RGBA（[L614-616](ktex_tool.py#L614-L616)）
- KTEX mip 数据行序自底向上，解码后需 `flipud` 上下翻转（[L638](ktex_tool.py#L638)）
- 解码依赖：`pip install texture2ddecoder`

## 5. 编码流程（RGBA → ASTC）

入口 `_encode_astc`（[L658-698](ktex_tool.py#L658-L698)），使用官方 `astc-encoder-py`：

```python
cfg = ASTCConfig(
    profile=ASTCProfile.LDR,        # 低动态范围（游戏贴图均为 LDR）
    block_x=8, block_y=8,           # 或 6x6
    quality=ASTCQualityPreset.MEDIUM,
)
ctx = ASTCContext(cfg)
img = ASTCImage(ASTCType.U8, dim_x=w, dim_y=h, dim_z=1, data=rgba.tobytes())
swz = ASTCSwizzle(R,G,B,A)          # 输入已是 RGBA，直接声明通道映射
data = ctx.compress(img, swz)
```

- 编码依赖：`pip install astc-encoder-py`
- 质量 MEDIUM 在体积/画质/速度间折中；profile 固定 LDR（不支持 HDR 块）

## 6. mipmap 链生成（[L940-982](ktex_tool.py#L940-L982)）

1. 先 `np.flipud(rgba)` 翻转，与 KTEX 存储方向一致
2. `_mip_chain_dims`（[L255-275](ktex_tool.py#L255-L275)）生成尺寸链：w,h 逐层减半直至 1x1
3. 每层用 PIL `Image.BILINEAR` 缩放（第 0 层用原图）
4. 每层独立调 `_encode_astc` 压缩（块取整向上，末层 1x1 仍占一块 16 字节）
5. 头部 `num_mips`、`flags bit0` 随层数更新；写出旧版布局

## 7. 格式自动检测（[L520-568](ktex_tool.py#L520-L568)）

当文件头声明格式与 mip0 数据大小不符时触发 `_detect_format`：

**无 texture2ddecoder**（纯数学推断）：
```
data_size == ceil(w/8)*ceil(h/8)*16 → ASTC8x8
data_size == ceil(w/6)*ceil(h/6)*16 → ASTC6x6
data_size == ceil(w/4)*ceil(h/4)*16 → DXT5
```

**有 texture2ddecoder**（实际解码评分）：对每个候选格式试解码 mip0，统计
`5 < 通道值 < 250` 的"有效像素"占比作为分数，取最高者。ASTC 解码器对错误
格式的数据会输出大量 0/255 极端值，因此该评分能可靠区分 DXT 与 ASTC。

## 8. 工具命令

```bash
# PNG → ASTC8x8（手机版推荐）
python ktex_tool.py png2tex atlas.png -f astc8x8 -o out

# .tex → .tex 格式互转（自动重生成 mip 链）
python ktex_tool.py convert a.tex -f astc6x6

# 查看 .tex / .zip / 目录信息（含压缩率）
python ktex_tool.py info atlas.tex

# 无参数进交互菜单
python ktex_tool.py
```

## 9. 压缩率实测参考

一张 512x512 RGBA32 贴图（1,048,576 字节）：

| 目标格式 | 主层大小 | 压缩到 |
|---------|---------|--------|
| ASTC8x8 | ceil(512/8)² × 16 = 65,536 B | **6.3%** |
| ASTC6x6 | ceil(512/6)² × 16 = 118,336 B | 11.3% |
| DXT5 | 128² × 16 = 262,144 B | 25% |
| ARGB | 1,048,576 B | 100% |

---

*时间：2026-08-28，基于 ktex_tool.py 当前版本分析，文档由AI生成。*
