# DST 模组整理与中文文稿流程

这套流程用于把 DST 创意工坊模组整理成站内可编辑的中文详情页，并避免重复抓取和重复翻译。

## 1. 准备输入

1. 将模组记录维护在 `data_src/dst_pan.json`，顶层 key 使用 `WS` 加 Steam 工坊数字 ID，例如 `WS376333686`。
2. 运行检查脚本：

```powershell
python data_src/check_dst_workshop_compliance.py
```

脚本通过 Steam 官方接口获取描述，输出到 `data_src/dst_workshop_compliance.json`。

普通运行会跳过两类已有记录：

- `dst_workshop_processed.json` 的 `completed_ids` 中已经完成中文稿的条目。
- 合规报告中已有缓存的条目。

只有新 ID 或没有缓存的条目会请求 Steam。需要重新抓取全部描述时才使用：

```powershell
python data_src/check_dst_workshop_compliance.py --refresh
```

## 2. 合规初筛

查看报告中的 `status`、`explicit_prohibition` 和 `matched_snippets`：

- `prohibited`：描述中检测到与搬运、移植、转载、再发布等行为相关的明确禁止措辞，不能直接整理为分享内容。
- `clear`：没有检测到明确禁令，不代表获得作者授权，仍需人工查看原文。
- `no-description`：工坊没有描述，不能据此判断许可。
- `error`：ID 无效或接口没有返回条目。

对“必须署名”“未经授权可能 DMCA”等内容，即使没有命中 `prohibited`，也要在中文稿中保留醒目的作者说明。

## 3. 整理中文文稿

这一步由 **AI 助手（GitHub Copilot）批量执行**，没有对应的命令行脚本；输入是上一步的 `dst_workshop_compliance.json` 里的 `description` 原文，输出是站内页面。

1. 找到或新建对应页面：`content/docs/dst-book/section-2-resources/mods/WSxxxxxxxx/index.md`（**page bundle 形式**，不是 `WSxxxxxxxx.md`）。
2. 保留原有 front matter、页面别名和工坊链接。
3. 将英文或 BBCode 描述整理为中文，而不是逐句硬翻：
   - 先写一句功能概述。
   - 再列出主要功能、操作方式、依赖和兼容性。
   - 保留作者、素材、署名、授权和 DMCA 提醒。
   - 不确定的内容写成“待人工确认”，不要根据模组名称臆造。
4. 在正文末尾保留：

```markdown
[查看创意工坊原页面](https://steamcommunity.com/sharedfiles/filedetails/?id=数字ID)
```

### 3.1 页面格式模板

```markdown
---
title: "WSxxxxxxxx"
weight: 2000
bookHidden: true
aliases:
  - "/p/WSxxxxxxxx"
workshop_fetched: true
chinese_draft_completed: true
processing_status: "completed"
---

## 中文名（English Title）

> 中文草稿：根据创意工坊描述整理，后续可继续校对。

（功能概述 1～2 段；复杂的模组用 `###` 分节，数值型内容用表格或列表）

[查看创意工坊原页面](https://steamcommunity.com/sharedfiles/filedetails/?id=xxxxxxxx)
```

约定：

- `title` 固定为工坊 ID（`WS` + 数字），`weight` 统一 `2000`，`bookHidden: true`，`aliases` 固定为 `/p/WSxxxxxxxx`。
- 三个状态字段只在“已抓取描述 + 中文稿已补齐”时才写。
- 正文标题用「中文名（English Title）」，尽量使用游戏内常用中文译名，例如 `## 更多地图图标（Extended Map Icons）`。
- 描述里出现的按键、配方、数值、材料、署名一律如实保留，不做二次推断。
- 描述过于简略时正文就写短，不要为了凑长度而扩写。

### 3.2 描述为空的条目

Steam 没有返回描述时（`status: no-description`），生成**占位页**并保持待补充状态：

```markdown
---
title: "WSxxxxxxxx"
weight: 2000
bookHidden: true
aliases:
  - "/p/WSxxxxxxxx"
---

## 中文名

> 中文草稿：当前抓取结果没有返回创意工坊描述，以下内容待人工补充。

工坊条目名称为「……」，但作者没有填写描述。请后续根据创意工坊页面补充功能介绍、使用方法、版本状态和作者说明。

[查看创意工坊原页面](https://steamcommunity.com/sharedfiles/filedetails/?id=xxxxxxxx)
```

占位页**不写**三个状态字段，也**不加入** `completed_ids`。

### 3.3 散页转 page bundle

如果页面还是散落的 `WSxxxxxxxx.md`，用脚本批量转换（默认只预览）：

```powershell
python data_src/batch_page_bundles.py                 # 预览
python data_src/batch_page_bundles.py --apply         # 实际转换
python data_src/batch_page_bundles.py --apply --delete-source   # 并删除原始 .md
```

## 4. 标记完成

只有“已成功抓取描述”且“中文草稿已补齐”的页面，才在 front matter 添加：

```yaml
workshop_fetched: true
chinese_draft_completed: true
processing_status: "completed"
```

然后把对应的 `WS...` ID 加入 `data_src/dst_workshop_processed.json` 的 `completed_ids`，并更新该文件的 `updated_at`（格式 `YYYY-MM-DD`）。

加入 `completed_ids` 后，后续普通运行**不会再请求 Steam**，直接复用报告里的缓存记录。

如果描述为空、ID 无效或文章仍是待补充占位稿，不要加入 `completed_ids`，放在 `pending_ids` 并写明原因。

## 5. 后续增量运行

新增模组后只需更新 `dst_pan.json`，再执行普通命令。脚本会保留已有报告，并只处理未出现在缓存或完成清单中的新条目。

重新抓取某个已完成条目时，先从 `completed_ids` 移除它，再运行脚本；需要全部重抓则使用 `--refresh`。重新整理完中文稿后，再恢复页面标记和完成清单。

## 5.1 Steam 订阅数（模组列表「↓ 下载」排序）

联机版模组页（`layouts/_shortcodes/dst-mods.html`）用 Steam 当前订阅数做排序与展示，数据来自：

```powershell
python data_src/fetch_dst_workshop_subs.py            # 抓取并写回
python data_src/fetch_dst_workshop_subs.py --dry-run  # 只看结果
python data_src/fetch_dst_workshop_subs.py --limit 5  # 试跑
```

只保留一个字段：`subs` = 接口的 `subscriptions`（Steam 当前订阅数），页面用它排序、并在模组图标下方显示成 `12.3万` 这种缩写。历史遗留的 `lifetime_subs`（`lifetime_subscriptions`）已废弃，脚本再次运行会自动清理掉。

脚本对 `data/dst_pan.yml`、`data_src/dst_pan.yml`、`data_src/dst_pan.json` 三份数据同时生效：

| 字段 | 含义 | 用途 |
| --- | --- | --- |
| `subs` | `subscriptions`，Steam 当前订阅数 | 图标下方显示缩写 +「↓ 下载」排序 |

约定：

- 字段插在 `size` 之前，写成与原有字段一致的 `- subs: 数字` 列表风格；重复运行幂等（只改数值，不动顺序）。
- `size` 的零值统一写作 `size: 0`（不是 `0B`）；页面遇到 0 不显示大小，模组列表里也不会出现「(0)」。
- `WS000000` 不是有效工坊 ID，脚本会跳过，其余条目应全部有 `subs`。
- 接口偶发 504/超时，脚本按 `--retries`（默认 3 次）指数退避重试。
- 订阅数会随时间变化，建议随模组增删一起重跑；页面上的数字即最近一次抓取结果。
- **`merge_pans.py` 会保留 `subs`**：它的字段白名单、合并保留逻辑、回写模板三处都要有 `subs`，
  少一处就会在「有变化才重写整条」时把订阅数抹掉（曾经踩过这个坑）。
  标准顺序是：先跑 `merge_pans.py` 合并网盘链接，再跑 `fetch_dst_workshop_subs.py` 补订阅数。

页面交互（`assets/js/ds-mods.js` 共用，单机版不受影响）：

- 工具栏只有一个排序按钮，两种排序、点一下来回切，按钮上用箭头图标表示正序/倒序：
  - `↑ 名称` → 正序，就是原来的按 ID 排序（ID 小到大），「名称」只是按钮上的显示叫法；
  - `↓ 下载` → 倒序，按 `subs`（Steam 当前订阅数）高到低。
- 方向跟着排序走、不单独切换；旁边的正序/倒序按钮只存在于单机版页面，行为未变。
- 选择记在 `localStorage`（`mods-sort-preference`，值 `name` / `downloads`），方向不记忆。
- 订阅数参与搜索：`10327525`、`1032.8万` 都能命中。
- 前端接线：shortcode 输出 `data-sort-downloads="true"`，`ds-mods.js` 读成配置字段 `cfg.subs`
  （有则渲染图标下的订阅数、启用「名称 / 下载」按钮；没有就退回单机版的按 ID + 正序/倒序）。

## 6. 一致性自检

批量整理完成后，核对三份数据的数量是否闭合：

| 数据 | 位置 | 期望 |
| --- | --- | --- |
| 模组条目 | `dst_pan.json` 中所有 `WS\d+` 键 | 基准数量 N |
| 详情页 | `mods/` 下的 `WSxxxxxxxx/` 目录 | N 个，不多不少 |
| 完成清单 | `dst_workshop_processed.json` | `completed_ids` + `pending_ids` = N |

再抽查每个页面：front matter 含 `title` / `weight` / `bookHidden` / `aliases`，正文含对应的工坊链接，且 `completed_ids` 里的 ID 都有页面、页面也都在清单里。

还要单独复核**授权 / 署名 / DMCA 类声明有没有如实保留**——这类内容**不会**被 `prohibited` 正则捕获（措辞不在禁止词表里，或与行为词的距离超出 180 字符），必须逐条比对描述原文与页面正文。典型例子：`WS1583765151`、`WS1824509831` 的「未经授权使用本模组内容（主要是纹理）可能引发 DMCA」，以及 `WS3759757365` 的 Copyright Notice（非商业重构、原作者 DYC、应要求可下架）。

> 2026-09-17 核对结果：74 个条目 = 74 个页面 = 70 条完成 + 4 条待补（`WS000000`、`WS3741973557`、`WS2074508776`、`WS2640834455`）。
