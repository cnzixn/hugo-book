---
title: "模组音效"
weight: 100
aliases:
  - "/p/sound"
---


### 工具

官方的 Don't Starve Mod Tools ，在“库”里面能搜到。

`D:\Program\steam\steamapps\common\Don't Starve Mod Tools\mod_tools\FMOD_Designer`


### 手机版

模组音效 fsb 里，只有“第 1 个”能正常播放。我不知道是啥原因，将 bank “拆分”一下能临时解决：

```plaintext  {filename="", copy="false", collapse="true"}
“景熹家居”中的“磁带”音效:

1. `jx_tape2.fev` —— **FEV 文件（2KB）**
2. `jx_tape2.fsb` —— **FSB 文件（6375KB）**

处理为以下：

1. `jx_tape3.fev` — FEV 事件文件，2KB
2. `jx_tape_1.fsb` — FSB 音频包，3286KB
3. `jx_tape_2.fsb` — FSB 音频包，3002KB
4. `jx_tape_3.fsb` — FSB 音频包，2484KB

```

### Events

对应生成的 xxx.fev 文件

{{< gallery caption="" href="" >}}
  DF30D4636BDED06ED5B52BFDED26445D.png
{{< /gallery >}}

### Banks

对应生成的 xxx.fsb 文件

{{< gallery caption="" href="" >}}
  E2038B6093AD70E06A8A2C4FA74C64DC.png
{{< /gallery >}}



