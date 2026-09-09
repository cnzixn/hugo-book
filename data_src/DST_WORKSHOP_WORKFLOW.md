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

1. 找到对应页面：`content/docs/dst-book/section-2-resources/mods/WSxxxxxxxx.md`。
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

## 4. 标记完成

只有“已成功抓取描述”且“中文草稿已补齐”的页面，才在 front matter 添加：

```yaml
workshop_fetched: true
chinese_draft_completed: true
processing_status: "completed"
```

然后把对应的 `WS...` ID 加入 `data_src/dst_workshop_processed.json` 的 `completed_ids`。

如果描述为空、ID 无效或文章仍是待补充占位稿，不要加入 `completed_ids`，放在 `pending_ids` 并写明原因。

## 5. 后续增量运行

新增模组后只需更新 `dst_pan.json`，再执行普通命令。脚本会保留已有报告，并只处理未出现在缓存或完成清单中的新条目。

重新抓取某个已完成条目时，先从 `completed_ids` 移除它，再运行脚本；需要全部重抓则使用 `--refresh`。重新整理完中文稿后，再恢复页面标记和完成清单。
