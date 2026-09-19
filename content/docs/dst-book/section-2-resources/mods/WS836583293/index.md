---
title: "WS836583293"
weight: 2000
bookHidden: true
aliases:
  - "/p/WS836583293"
workshop_fetched: true
chinese_draft_completed: true
processing_status: "completed"
---

## 物品信息（Item Info）


属于 **CLIENT 模组**，在任何服务器上都能使用，无需服务器安装。

### 功能

- 鼠标悬停物品时，用小图标加数值显示其属性：饥饿、理智、生命、腐烂时间、保暖值（冬/夏）、剩余照明时间、防水百分比、每分钟理智增益、剩余使用次数、伤害与护甲（含平面伤害/护甲）。
- 可在右侧面板显示当前已装备物品的信息（可开关），方便随时查看长矛剩余次数、护甲剩余耐久、火把何时烧完。

### 配置项

- **Info scale**：提示信息的缩放。
- **Time format**：时间显示为「时:分:秒」或游戏内天数。
- **Perish info**：只显示腐坏时间、先显示变质时间再显示腐坏时间，或两者都显示。
- **Show info hands/body/head**：是否显示已装备物品的信息。
- **Equipped Scale**：已装备物品信息的缩放。
- **Show prefab name**：是否显示物品的调试生成名。
- **Show background**：是否为已装备物品显示背景板。
- **Margin bottom/right**：调整已装备物品信息的位置。

### 说明与注意事项

- 安装方式：订阅即可，不需要替换字体。
- 数值是按「物品当前百分比 × 基础最大值」推算的，因此以下数值可能并非 100% 精确：腐坏时间、变质时间、燃料时间、衣物剩余时间、剩余次数、火腿棒伤害。
- 0.2 版起支持手柄。
- 已知问题：与 `modcomponentactions` 相关的 bug（仅在模组服务器出现，源于本模组生成基础物品来读取属性的方式），已修复；Wortox 之后的新角色尚未完全支持（如他们不吃的食物、食物加成、伤害加成等）。
- 近期改动：修复悬停人鱼工具与升级人鱼工具时崩溃；新增平面伤害/护甲显示；腐烂计算支持极地熊獾桶；沃夫冈伤害支持其力量槽。

[查看创意工坊原页面](https://steamcommunity.com/sharedfiles/filedetails/?id=836583293)
