---
title: "关于 klump.zip 文件"
bookHidden: true
weight: 100
aliases:
  - "/p/klump"
---

## 文件结构
-----

### 1. 模组包位置

```plaintext  {{filename="xxx.apk", copy="false"}}
xxx.apk
└── assets
    └── databundles
        ├── klump.zip             ← 模组包
        └── ...
```

```plaintext  {{filename="xxx.ipa", copy="false"}}
xxx.ipa
└── Payload
    └── dontstarvetogether.app
        └── data
            └── databundles
                ├── klump.zip     ← 模组包
                └── ... 
```




### 2. 模组包结构

```plaintext  {{filename="klump.zip", copy="false"}}
klump.zip
└── mods/
    ├── modsettings.lua           ← 配置文件
    ├── workshop-mpatch           ← 模组A
    │   ├── modinfo.lua
    │   └── ...
    └── workshop-376333686        ← 模组B
        ├── modinfo.lua
        └── ...
```

注：模组文件夹 mods 放到任意一个 databundles 的压缩包里都行。官方的 klump.zip 暂未使用，正好废物利用一下。


### 3. 配置文件

```lua  {{filename="modsettings.lua", copy="false"}}
  Add("workshop-mpatch")      -- 模组A
  Add("workshop-376333686")   -- 模组B
```
