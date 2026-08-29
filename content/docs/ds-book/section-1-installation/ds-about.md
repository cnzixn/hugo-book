---
title: "关于 apk/ipa 文件"
bookHidden: true
weight: 100
aliases:
  - "/p/ds-about"
---

## 文件结构
-----

### 1. 安卓安装包结构

```plaintext  {{filename="xxx.apk", copy="false"}}
xxx.apk
└─ assets
  └─ mods/
    ├─ bmmods.lua                ← 配置文件
    ├─ mod-test                  ← 模组A
    │   ├── modinfo.lua
    │   └── ...
    └─ workshop-12345678        ← 模组B
        ├── modinfo.lua
        └── ...
```

### 2. 苹果安装包结构

```plaintext  {{filename="xxx.ipa", copy="false"}}
xxx.ipa
└─ Payload/
  └─ dontstarve.app/
    ├─ dlc0002.archive
    ├─ data.archive
    └─ ...
```
注：苹果端的数据包使用 `archive` 格式，需自行解包/打包（暂不公布算法）。

### 3. 配置文件

```lua  {{filename="bmmods.lua", copy="false"}}
  -- BMXXX 模组无需添加，框架会自动加载
  Add("BM000")                -- 重复添加，没啥用

  -- 其他模组需要手动添加
  Add("mod-test")             -- 模组A
  Add("workshop-12345678")    -- 模组B
```
