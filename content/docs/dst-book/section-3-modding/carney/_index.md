---
title: "卡尼猫移植实战"
weight: 100
aliases:
  - "/p/carney"
---


> [!TIP]
> Q：可以更新点mod吗？  
> A：我“有空”就会移植一些，但就算把我累死，也无法满足所有人。——“自己动手，丰衣足食”


下面的教程，全程不写一行代码，将创意工坊的“卡尼猫”模组移植适配到手机版。

## 一、模组贴图处理
-----


工具：[ktex_tool.py](/files/ktex_tool.py)

相关资料： [KTEX 工具的简单实现](/p/ktex)，有问题请自行用 AI 工具修复。

```powershell {collapse="true"}
PS D:/Project/dst> py d:/Project/dst/ktex/ktex_tool.py
==================================================
   KTEX 贴图转换工具  (DXT5 / ASTC8x8 / ASTC6x6 / ARGB)
==================================================

支持的操作:
  1) tex2png  —  .tex -> .png   (解码贴图)
  2) png2tex  —  .png -> .tex   (编码贴图)
  3) convert  —  .tex -> .tex   (格式互转)
  4) info     —  显示 .tex/.zip 详细信息

可输入: 文件 / 文件夹 / .zip (ZIP 会自动解压处理内部 .tex)

请选择操作 [1/2/3/4] [1]: 3
输入文件/文件夹/zip 路径（多个用逗号分隔）: d:/Project/dst/mods/949808360
输出目录（留空=原地，ZIP输出到同级 <zip>_out）: 

可选格式:
  1) argb       通用格式 (未压缩)
  2) dxt5       DST电脑版 (BC3)
  3) astc8x8    DST手机版 (推荐)
  4) astc6x6    DST手机版 (备用)

选择格式编号 [1]: 3
生成 mipmap 链? [Y/n] [y]: 

--------------------------------------------------
操作    : convert
路径    : ['d:/Project/dst/mods/949808360']
输出目录: (原地)
目标格式: ASTC8x8  (mipmap=on)
--------------------------------------------------

2026-09-10 21:23:58,298 [INFO] 找到 19 个原生文件
2026-09-10 21:23:58,298 [INFO] [convert] d:/Project/dst/mods/949808360/modicon.tex -> d:/Project/dst/mods/949808360/modicon.tex  (fmt=ASTC8x8)

......

d:/Project/dst/mods/949808360/anim/whiteberet_plus.zip  (fmt=ASTC8x8)
2026-09-10 21:24:14,398 [INFO] [OK] ZIP d:/Project/dst/mods/949808360/anim/windyknife.zip  (fmt=ASTC8x8)

完成 ✓
PS D:/Project/dst> 
```

## 二、进游戏测试
-----

贴图弄完就完美运行，这就是“老资历”?

{{< gallery caption="" href="" >}}
  4E1D00EC26BA13447646E34725E62C3E.png
{{< /gallery >}}

“如果有代码报错，怎么办？”，直接问 AI 就行。

游戏日志在 `/storage/emulated/0/Android/data/<package>/files/saves/logs/client_log.txt` 


## 三、技能按键适配
-----

我用的 AI 工具是 [Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) ，我懒得看模组代码，直接让它帮我看：

```markdown {collapse="true"}
💬 D:\Project\dst\mods\949808360 ，先看看有哪几个“技能”

🐋 看完了，949808360 是「卡尼猫 / Carney」自定义角色 mod（v2.2.8）。
mod 里的"技能"不是 DST 官方技能树，而是靠按键触发 + ModRPC 实现的战斗技能，
全部注册在 mods\949808360\scripts\carney_util\carney_util.lua（按键绑定在 142–194 行），
实际效果在 scripts\prefabs\carney.lua 和 scripts\components\carneystatus.lua。

主动技能（4 个 + 1 个空壳）
技能	默认键	RPC	效果	代价/限制
闪避 / Dodge	R (114)	Dodge	播 jumpout 动画，0.8s 内速度分 25 段飙升，miss=1 期间 GetAttacked 被替身拦截→免疫伤害（shadow_shield3 特效），加 heavybody，并临时改碰撞掩码可穿过障碍	冷却 0.9s（missactioning）；持续时长随等级 0.35+lv/100×0.35；骑牛时不可用
蓄力 / Charge	Z (122)	Charge	设 power=1，生成 carneychargefx 挂在武器上，攻击倍率 = lv*5/200 + 1.25（1.25×→2.5×），命中时爆一段火焰特效	必须手持近战武器；回旋镖/吹箭/水球/催眠炸弹无效；命中后饥饿 −5（饥饿已为 0 时额外扣 5 血），卸下武器也会取消
冰柱 / Icicle	C (99)	Icicle	两段式：第 1 次按键布置 freshaura 光环（正电子束+冰圈特效），饥饿 −15；第 2 次按键引爆，半径 3 内 AoE 伤害 = (lv+20)*(power/4+1)*(1+敌人数/10)，雷击+爆炸	饥饿 ≤0 时额外扣 15 血；死亡时自动引爆；若此时处于蓄力状态会一并消耗蓄力
自我检查 / Check	J (106)	Check	说话报数：lv X exp Y/maxexp	无
（占位）	K	K	RPC 已注册但函数体全被注释掉，目前是空技能	—
按键可在 mod 配置里改（modinfo.lua 的 DodgeKey/ChargeKey/IcicleKey/CheckKey），默认就是描述里的 "RZC"。

```

可以看到，它找到了 4 个按键。因为“闪避”技能比较常用，我决定它让常驻。另外 3 个技能，放到“轮盘”折叠起来，避免屏幕上“按钮”过多。


```txt {collapse="true"}
💬 读 api 文档，然后适配手机版操作：闪避放到“动作按钮-人物技能”，蓄力、冰柱、自我检查用“轮盘”（mpatch里复制过来）  

🐋 读了什么
docs/MOD_API.md（§7 客户端/服务端分裂、§8 移动端/触屏、§8.9 两个技能按钮、§9 防御式写法）、docs/PORTING.md、docs/NEW_PORT_PROMPT.md，并用 work140/scripts/ 官方源码逐个核对：widgets/actioncontrols.lua（按钮结构 + 触摸→OnControl→onclick 链路）、frontend.lua（触摸派发/touchwidget/StartUpdatingWidget）、components/playeractionpicker.lua（pointspecialactionsfn 为 nil → 技能2 位平时是空的）、screens/playerhud.lua（编辑模式判定）。

入口判定：官方左侧两个技能位里，handActionButton 是手持物品的 AOE 位，specialActionButton（技能2，action_skill2.tex，自带 info 文字框）才是角色“点地/双击特殊动作”位（威尔逊投火把、Wheeler 闪避 DODGE、景熹射门都挂这里）→ 闪避放这里；三个非位移技能进轮盘。

改了什么
文件	改动
carney_util.lua	抽出客户端技能入口 CarneyClientDodge/Charge/Icicle/Check + SendCarneyRPC（发送时现取 GetModRPC，回落 legacy MOD_RPC），经 GLOBAL.CARNEY_CLIENT_ACTIONS 暴露；PC 键位改调同一份函数，服务端 RPC handler 未动。闪避补回本地起手动画（服务端 AnimState 不会同步到客户端）
carney_mobile.lua（新）	包装 actioncontrols:OnUpdate，卡尼猫时把技能2 位接管为「闪避」：改写 onclick、info 文字、冷却置灰；换角色/编辑模式还原官方 onclick，并用官方同一套 IsActionsAllowed（制作栏/指令轮盘/法术轮盘/IsActionsVisible）避免抢显隐
radial_wheel.lua（新，复制自 MPatch）	只改三处：RADIAL_WHEEL_CONFIG 三个显式 fn 选项（蓄力/冰柱/自检，sort_by_key=false 保序）、新增 owner_prefab="carney" 守卫（非卡尼猫隐藏轮盘按钮）、IsEditMode() 改用官方 PlayerHud:IsInEditMode()；auto_capture_keys=false，不去抢别的模组键位
modmain.lua	CarneyIsMobile() + 仅移动端客户端 modimport 两个 main 文件（PC 保留键位，专用服务器不加载）
strings_carney_c.lua
 / strings_carney_e.lua
STRINGS.CARNEYUI 增加技能名与轮盘说明
modinfo.lua
描述补手机版操作一行


```

上面提到的 api 文档也是让 AI 总结的，直接把官方代码给它就行。“轮盘”是之前写的通用模板[radial_wheel.lua](/files/radial_wheel.lua)，也全是 AI 自己写的，我全程只是“指挥”它干活。


{{< gallery caption="" href="" >}}
  F4E58108E30BC3D7EF2CB3CDDE4C485F.png
{{< /gallery >}}

完整的对话记录：[Harness-42fb9176-对话快照](/html/42fb9176-对话快照.html)

附件：
- [baidu/260913/949808360.zip](https://pan.baidu.com/s/1pQpO_uysAZnbcG2ol4pYtg?pwd=ve4i)
- [quark/260913/949808360.zip](https://pan.quark.cn/s/7df778ae0586?pwd=x3hF)


## 四、给作者点赞
-----

{{< gallery caption="向我支付“鲸元券”，赞助作者↗" href="/about" >}}
  CA8AC56B13AB3110467543FB2F574C4F.png
{{< /gallery >}}

