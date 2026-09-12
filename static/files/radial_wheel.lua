-- 手机端通用径向轮盘。
-- 在 modmain 用 modimport("xxx/radial_wheel.lua") 导入。
-- 其他模组复用时，只需修改下面的 RADIAL_WHEEL_CONFIG：
--   1. options：有 key 时模拟按键，否则有 fn 时直接执行函数
--   2. main_button：主按钮的文字和贴图
-- key 选项模拟原始按键的“按下 -> 松开”；fn 选项调用 fn(controls, option)。

-- 声明模组 API 函数
local GLOBAL = GLOBAL
local AddClassPostConstruct = AddClassPostConstruct
local GetModConfigData = GetModConfigData
local modname = modname

GLOBAL.setfenv(1, GLOBAL)

--------------------------------------------------------------------------
-- 用户配置区：复用时只改这一段
--------------------------------------------------------------------------
local RADIAL_WHEEL_CONFIG = {
    -- 同一游戏中存在多个轮盘时，id 必须不同。
    rid = modname,

    -- 显式菜单示例：
    -- options = {
    --     { label = "T", key = KEY_T },
    --     { label = "功能", fn = function(controls, option) ... end },
    -- },
    -- options 为 nil 时自动捕获，options 为表时只使用显式选项。
    options = nil,
    auto_capture_keys = nil,
    -- 是否开启按键去重。
    -- 默认关闭，方便用户知道有键位冲突。
    deduplicate_keys = false,
    sort_by_key = true,

    main_button = {
        atlas = HUD2_ATLAS,
        image = "ping_wow.tex",
        text = "+",
        text_size = 32,
        text_colour = { 1, .8, 0, 1 },
        text_offset = { 3, 0 },
        scale = 1.0,
        normal_colour = { .3, .3, .3, .75 },
        -- Musha 有自己的技能轮盘，隐藏通用轮盘以避免触摸区域重叠。
        is_available = function(player)
            return player == nil or player.prefab ~= "musha"
        end,
        -- 默认放在“副动作”左边。
        secondary_offset = { -120, 0 },
        fallback_position = { -250, -10 },
    },

    -- 编辑模式中用于保存主按钮位置的唯一名称。
    editable_name = "edit_" .. modname .. "_radial_wheel",
    hide_action_buttons_while_open = true,
    show_empty_slots = false,
    minimum_outer_slots = 4,
}
--------------------------------------------------------------------------

-- ## 轮盘菜单按键捕获

-- ### 自动捕获 
-- 轮盘菜单通过 Hook `TheInput:AddKeyDownHandler` 和 `TheInput:AddKeyUpHandler` 自动收集其他模组注册的快捷键。按住主按钮滑动选择，松手模拟原始按键事件：

-- ```lua
-- -- 两者都触发
-- TheInput:OnRawKey(key, true)  -- 按下
-- TheInput:OnRawKey(key, false) -- 松开
-- ```

-- ### 手动标记（`AddKeyHandler` 类模组需要）

-- 部分模组（如精灵公主 MUSHA）使用 `AddKeyHandler` 接收全部原始按键，再通过组件内部的 `AddActionListener` 转发为玩家事件/RPC。调用链如下：

-- ```lua
-- common_postinit:
--   inst:AddComponent("keyhandler")
--     → KeyHandler 构造函数调用 TheInput:AddKeyHandler(fn)
--        └─ fn(key, down) 接收所有按键，无具体 key 声明

--   inst.components.keyhandler:AddActionListener("musha", TUNING.MUSHA_KEY, "INFO")
--     → inst:ListenForEvent("keypressed", closure)
--        └─ closure 以闭包 upvalue 捕获 TUNING.MUSHA_KEY
--           └─ 按键映射不在 Input 层，轮盘无法自动发现
-- ```

-- **轮盘菜单无法自动捕获的原因**：
-- - `AddKeyHandler(fn)`  注册的回调不声明具体按键（`fn(key, down)` 接收所有按键）
-- - 按键→动作的映射在 `AddActionListener` 的闭包 upvalue 中，不在 Input 事件总线

-- **解决方案**：此类模组，自行在 modmain.lua 添加“空函数”注册，以供被自动捕获：

-- ```lua
-- -- 模组 MUSHA 的 modmain.lua 添加代码：
-- if TheNet == nil or not TheNet:IsDedicated() then
--     local keys = { TUNING.MUSHA_KEY, TUNING.MUSHA_KEY2, TUNING.MUSHA_KEY3,
--                    TUNING.MUSHA_KEY4, TUNING.MUSHA_KEY5, TUNING.MUSHA_KEY6,
--                    TUNING.MUSHA_KEY7, TUNING.MUSHA_KEY8, TUNING.MUSHA_KEY9,
--                    TUNING.MUSHA_KEY10, TUNING.MUSHA_KEY11, TUNING.MUSHA_KEY12 }
--     local seen = {}
--     for _, key in ipairs(keys) do
--         if type(key) == "number" and not seen[key] then
--             -- 确保每个按键只注册一次
--             seen[key] = true
--             -- 空函数，不改变原模组逻辑
--             TheInput:AddKeyUpHandler(key, function() end)
--         end
--     end
-- end
-- ```






-- Dedicated server does not create HUD widgets.
if TheNet ~= nil and TheNet:IsDedicated() then
    return
end

local Widget = require("widgets/widget")
local Image = require("widgets/image")
local Text = require("widgets/text")
local ImageButton = require("widgets/imagebutton")

local LOG_PREFIX = "[RadialWheel:" .. tostring(RADIAL_WHEEL_CONFIG.rid) .. "] "
local function Log(message)
    print(LOG_PREFIX .. tostring(message))
end

Log("module load")

local OUTER_COUNT = 12
local INNER_COUNT = 8
local OUTER_RADIUS = 280
local INNER_RADIUS = 160
local CENTER_RADIUS = 100
local BTN_SCALE = 1.5
-- 最外圈 12 项、内圈 8 项；选项较少时最少显示 4 个外圈槽位。
local SHOW_EMPTY_TEST_SLOTS = RADIAL_WHEEL_CONFIG.show_empty_slots == true
local MIN_VISIBLE_OUTER_SLOTS = RADIAL_WHEEL_CONFIG.minimum_outer_slots or 4

-- 轮盘选项：有 key 时优先模拟按键，否则执行 fn。
local REGISTERED_KEYS = {}
local SEEN_KEYS = {}
-- fn 模式（显式 options 中仅有 label+fn、无 key 字段的条目）按 label 去重：
-- 与 key 模式的 SEEN_KEYS 对应，避免显式 options 被重复加载时生成 N 条同 label 的 fn 按钮。
-- fn 模式默认无条件去重（label 相同 = 同一功能，不存在"跨模组冲突需可见"的意义）。
local SEEN_FN_LABELS = {}

-- 按键数字 → 可读名称 映射表（从游戏 KEY_* 常量自动生成）
local KEY_NAMES = {}
do
    local prefix = "KEY_"
    for k, v in pairs(GLOBAL) do
        if type(k) == "string" and type(v) == "number" and k:sub(1, #prefix) == prefix then
            KEY_NAMES[v] = k:sub(#prefix + 1)
        end
    end
end

local function KeyName(key)
    return KEY_NAMES[key] or ("#" .. tostring(key))
end

local function ShouldAutoCaptureKeys()
    if RADIAL_WHEEL_CONFIG.auto_capture_keys ~= nil then
        return RADIAL_WHEEL_CONFIG.auto_capture_keys == true
    end
    return RADIAL_WHEEL_CONFIG.options == nil
end

-- 记录可由轮盘模拟的按键。
local function RecordKey(key)
    if type(key) ~= "number" then return end
    if RADIAL_WHEEL_CONFIG.deduplicate_keys and SEEN_KEYS[key] then return end
    SEEN_KEYS[key] = true
    local name = KeyName(key)
    Log("RecordKey key=" .. tostring(key) .. " name=" .. name)
    table.insert(REGISTERED_KEYS, { key = key, label = name })
end

local function IsOptionAvailable(option)
    if option == nil or type(option.is_available) ~= "function" then
        return true
    end
    return option.is_available(ThePlayer, option) == true
end

local function LoadConfiguredOptions()
    for _, option in ipairs(RADIAL_WHEEL_CONFIG.options or {}) do
        if type(option) == "table" then
            local valid = type(option.key) == "number" or type(option.fn) == "function"
            if valid then
                local slot = {
                    key = option.key,
                    fn = option.fn,
                    label = option.label or (option.key ~= nil and KeyName(option.key)) or "?",
                    atlas = option.atlas,
                    image = option.image,
                    text_colour = option.text_colour,
                    description = option.description,
                    is_available = option.is_available,
                }
                if slot.key ~= nil then
                    -- key 模式：沿用原有 deduplicate_keys 开关 + SEEN_KEYS 去重。
                    if slot.key == nil or not RADIAL_WHEEL_CONFIG.deduplicate_keys or not SEEN_KEYS[slot.key] then
                        if slot.key ~= nil then SEEN_KEYS[slot.key] = true end
                        table.insert(REGISTERED_KEYS, slot)
                    end
                else
                    -- 纯 fn 模式：按 label 去重（同 label 视为重复，不再依赖 deduplicate_keys，
                    -- 因为 fn 重复本质上是同一功能按钮被注册 N 次，不是"冲突"）。
                    if slot.label == nil or not SEEN_FN_LABELS[slot.label] then
                        if slot.label ~= nil then SEEN_FN_LABELS[slot.label] = true end
                        table.insert(REGISTERED_KEYS, slot)
                    end
                end
            else
                Log("ignore invalid option: key/fn missing")
            end
        end
    end
end

-- 扫描 TheInput 中已注册的按键事件（在 hook 安装前已注册的）
local function ScanExistingKeys()
    Log("ScanExistingKeys start")
    if TheInput == nil then Log("ScanExistingKeys: TheInput nil") return end
    local found = 0
    if TheInput.onkeydown and TheInput.onkeydown.events then
        for key, handlers in pairs(TheInput.onkeydown.events) do
            if type(key) == "number" then
                for handler, _ in pairs(handlers) do
                    RecordKey(key)
                    found = found + 1
                    break
                end
            end
        end
    end
    if TheInput.onkeyup and TheInput.onkeyup.events then
        for key, handlers in pairs(TheInput.onkeyup.events) do
            if type(key) == "number" then
                for handler, _ in pairs(handlers) do
                    RecordKey(key)
                    found = found + 1
                    break
                end
            end
        end
    end
    Log("ScanExistingKeys done, found=" .. tostring(found))
end

-- Hook TheInput 的按键注册函数，拦截后续注册
local function InstallKeyHooks()
    if not ShouldAutoCaptureKeys() then return end
    Log("InstallKeyHooks start")
    if TheInput == nil then
        Log("InstallKeyHooks skip: TheInput nil")
        return
    end
    TheInput._radial_wheel_key_hooks = TheInput._radial_wheel_key_hooks or {}
    if TheInput._radial_wheel_key_hooks[RADIAL_WHEEL_CONFIG.rid] then
        Log("InstallKeyHooks skip: already installed")
        return
    end
    TheInput._radial_wheel_key_hooks[RADIAL_WHEEL_CONFIG.rid] = true

    ScanExistingKeys()

    local orig_down = TheInput.AddKeyDownHandler
    if orig_down then
        TheInput.AddKeyDownHandler = function(self, key, fn)
            RecordKey(key)
            return orig_down(self, key, fn)
        end
    end

    local orig_up = TheInput.AddKeyUpHandler
    if orig_up then
        TheInput.AddKeyUpHandler = function(self, key, fn)
            RecordKey(key)
            return orig_up(self, key, fn)
        end
    end

    Log("InstallKeyHooks done, total keys=" .. tostring(#REGISTERED_KEYS))
end

LoadConfiguredOptions()

-- 轮盘 Widget
local RadialWheel = Class(Widget, function(self)
    Widget._ctor(self, "RadialWheel_" .. tostring(RADIAL_WHEEL_CONFIG.rid))
    self:SetHAnchor(ANCHOR_MIDDLE)
    self:SetVAnchor(ANCHOR_MIDDLE)
    self:SetPosition(0, 0, 0)
    self:SetClickable(false)

    -- self.overlay = self:AddChild(Image("images/frontend.xml", "square.tex"))
    -- self.overlay:SetHAnchor(ANCHOR_MIDDLE)
    -- self.overlay:SetVAnchor(ANCHOR_MIDDLE)
    -- self.overlay:SetScaleMode(SCALEMODE_FILLSCREEN)
    -- self.overlay:SetTint(0, 0, 0, 0)
    -- self.overlay:SetClickable(false)

    -- self.outer_ring = self:AddChild(Image("images/frontend.xml", "circle.tex"))
    -- self.outer_ring:SetSize((OUTER_RADIUS + 45) * 2, (OUTER_RADIUS + 45) * 2)
    -- self.outer_ring:SetTint(.05, .12, .22, .95)
    -- self.outer_ring:SetClickable(false)

    -- self.inner_ring = self:AddChild(Image("images/frontend.xml", "circle.tex"))
    -- self.inner_ring:SetSize((INNER_RADIUS + 30) * 2, (INNER_RADIUS + 30) * 2)
    -- self.inner_ring:SetTint(.18, .27, .42, .98)
    -- self.inner_ring:SetClickable(false)

    local atlas = HUD2_ATLAS
    local normal = "ping_wow.tex"
    self.cancel = self:AddChild(Image(atlas, normal))
    -- self.cancel:SetSize(CENTER_RADIUS*2.8, CENTER_RADIUS*2.8)
    self.cancel:SetScale(BTN_SCALE*1.5)
    self.cancel:SetClickable(false)
    self.cancel:SetTint(.65, .10, .10, 1)
    self.cancel_label = self.cancel:AddChild(Text(BODYTEXTFONT, 32, "NO"))
    self.cancel_label:SetColour(1, 1, 1, .95)
    self.cancel_label:SetPosition(3, 0, 0)

    self.description_label = self:AddChild(Text(BODYTEXTFONT, 50, ""))
    -- self.description_label:SetRegionSize(CENTER_RADIUS * 3, CENTER_RADIUS * 3)
    self.description_label:EnableWordWrap(true)
    -- self.description_label:SetColour(1, 1, 1, .95)
    -- self.description_label:SetPosition(0, 0, 0)
    -- self.description_label:SetClickable(false)
    self.description_label:Hide()

    local atlas, normal = "images/frontend.xml", "circle.tex"
    self.touch_marker = self:AddChild(Image(atlas, normal))
    self.touch_marker:SetSize(30, 30)
    -- self.touch_marker:SetTint(1, .75, 0, 1)
    self.touch_marker:SetTint(.5, .5, .5, 1)
    self.touch_marker:SetClickable(false)
    self.touch_marker:Hide()

    self.outer = {}
    self.inner = {}
    self.outer_pool = {}
    self.inner_pool = {}
    self.selected = 0
    self:Hide()
end)

function RadialWheel:Open(options, layout)
    -- 每次打开都重新将轮盘放在 overlayroot 中心。
    self:SetPosition(0, 0, 0)
    self.cancel:SetPosition(0, 0, 0)
    self.touch_marker:SetPosition(0, 0, 0)
    self.touch_marker:Show()
    self.outer, self.inner = {}, {}

    local slots = {}
    for _, option in ipairs(options or REGISTERED_KEYS) do
        if IsOptionAvailable(option) then
            slots[#slots + 1] = option
            if #slots >= OUTER_COUNT + INNER_COUNT then
                break
            end
        end
    end
    if RADIAL_WHEEL_CONFIG.sort_by_key then
        table.sort(slots, function(a, b)
            local a_has_key = type(a.key) == "number"
            local b_has_key = type(b.key) == "number"
            if a_has_key and b_has_key then
                return a.key < b.key
            elseif a_has_key ~= b_has_key then
                return a_has_key
            end
            return tostring(a.label) < tostring(b.label)
        end)
    end

    -- 根据选项数量生成槽位；最多 20 个，选项不足时保留至少 4 个外圈槽位。
    layout = layout or {}
    local show_empty = layout.show_empty_slots == true
    local minimum_outer = layout.minimum_outer_slots or MIN_VISIBLE_OUTER_SLOTS
    local outer_count = show_empty and OUTER_COUNT or math.max(minimum_outer, math.min(#slots, OUTER_COUNT))
    local inner_count = show_empty and INNER_COUNT or math.min(math.max(#slots - OUTER_COUNT, 0), INNER_COUNT)

    local function ConfigureRing(pool, active, slot_source, count, radius, scale, fontsize)
        -- 从 12 点方向开始，按顺时针排列。
        for index = 1, count do
            local item = pool[index]
            if item == nil then
                local button = self:AddChild(ImageButton(HUD2_ATLAS, "ping_wow.tex"))
                button:SetClickable(false)
                local label = button:AddChild(Text(BODYTEXTFONT, fontsize, ""))
                label:SetPosition(3, 0, 0)
                label:SetClickable(false)
                item = { button = button, label_widget = label }
                pool[index] = item
            end
            local slot = slot_source[index]
            local angle = math.rad(90 - (index - 1) * 360 / count)
            local x, y = radius * math.cos(angle), radius * math.sin(angle)
            item.slot = slot
            item.button:SetTextures((slot ~= nil and slot.atlas) or HUD2_ATLAS, (slot ~= nil and slot.image) or "ping_wow.tex")
            item.button:SetPosition(x, y, 0)
            item.button:SetScale(scale)
            item.button:SetImageNormalColour(.3, .3, .3, .8)
            item.button:Show()
            if slot ~= nil then
                item.label_widget:SetString(slot.label or "")
                item.label_widget:SetColour(unpack(slot.text_colour or { 1, 1, 1, .95 }))
                item.label_widget:Show()
            else
                item.label_widget:Hide()
            end
            active[#active + 1] = item
        end
        for index = count + 1, #pool do
            pool[index].slot = nil
            pool[index].button:Hide()
        end
    end

    ConfigureRing(self.outer_pool, self.outer, slots, outer_count, OUTER_RADIUS, BTN_SCALE, 32)
    local inner_slots = {}
    for i = 1, inner_count do inner_slots[i] = slots[OUTER_COUNT + i] end
    ConfigureRing(self.inner_pool, self.inner, inner_slots, inner_count, INNER_RADIUS, BTN_SCALE, 24)

    self:Show()
    self:MoveToFront()
    self:SetHighlight(-1)
end

function RadialWheel:Close()
    self.selected = -1
    self.touch_marker:Hide()
    self:Hide()
end

function RadialWheel:SetVirtualTouch(dx, dy)
    self.touch_marker:SetPosition(dx or 0, dy or 0, 0)
    self.touch_marker:Show()
    self.touch_marker:MoveToFront()
end

function RadialWheel:SetHighlight(index)
    local function SetItemColour(item, selected)
        item.button:SetImageNormalColour(selected and 1 or .3, selected and .7 or .3, 0, selected and .95 or .8)
    end
    for _, item in ipairs(self.outer) do SetItemColour(item, false) end
    for _, item in ipairs(self.inner) do SetItemColour(item, false) end
    self.cancel:SetTint(.65, .10, .10, 1)
    self.selected = index
    local selected_item = nil
    if index > 0 and index <= #self.outer then
        selected_item = self.outer[index]
        SetItemColour(selected_item, true)
    elseif index > #self.outer and index <= #self.outer + #self.inner then
        selected_item = self.inner[index - #self.outer]
        SetItemColour(selected_item, true)
    elseif index == -1 then
        self.cancel:SetTint(1, .22, .22, 1)
    end
    local description = selected_item ~= nil
        and selected_item.slot ~= nil
        and selected_item.slot.description
        or nil
    if description ~= nil and description ~= "" then
        self.cancel:Hide()
        self.description_label:SetString(description)
        self.description_label:Show()
    else
        self.description_label:Hide()
        self.cancel:Show()
    end
end

function RadialWheel:GetSelectedOption()
    if self.selected > 0 and self.selected <= #self.outer then
        return self.outer[self.selected].slot
    elseif self.selected > #self.outer and self.selected <= #self.outer + #self.inner then
        local item = self.inner[self.selected - #self.outer]
        return item ~= nil and item.slot or nil
    end
end

-- 创建触发按钮，放在"副动作"按钮左边
local function CreateRadialWheelButton(controls)
    Log("CreateRadialWheelButton start")
    local ac = controls.actioncontrols
    if ac == nil then Log("actioncontrols nil") return end

    local main_cfg = RADIAL_WHEEL_CONFIG.main_button
    local button = ac:AddChild(ImageButton(main_cfg.atlas, main_cfg.image))
    button:SetScale(main_cfg.scale or 1)
    button:SetImageNormalColour(unpack(main_cfg.normal_colour or { 1, 1, 1, 1 }))
    if main_cfg.text ~= nil and main_cfg.text ~= "" then
        local text = button:AddChild(Text(BODYTEXTFONT, main_cfg.text_size or 32, main_cfg.text))
        local text_offset = main_cfg.text_offset or { 0, 0 }
        text:SetPosition(text_offset[1] or 0, text_offset[2] or 0, 0)
        text:SetColour(unpack(main_cfg.text_colour or { 1, 1, 1, 1 }))
    end

    local secondary = ac.secondaryButton
    if secondary ~= nil then
        local pos = secondary:GetPosition()
        local offset = main_cfg.secondary_offset or { -120, 0 }
        button:SetPosition(pos.x + (offset[1] or 0), pos.y + (offset[2] or 0), 0)
    else
        local fallback = main_cfg.fallback_position or { -250, -10 }
        button:SetPosition(fallback[1] or 0, fallback[2] or 0, 0)
    end
    TheFrontEnd:AddEditableWidget(button, RADIAL_WHEEL_CONFIG.editable_name, 80, 80)
    Log("button created")

    local wheel = nil
    local holding = false
    local touch_id = nil
    local last_touch_x, last_touch_y = nil, nil
    local last_global_move_id, last_global_move_x, last_global_move_y = nil, nil, nil
    local virtual_x, virtual_y = 0, 0
    local WHEEL_MAX_RADIUS = OUTER_RADIUS + 38
    local actioncontrols_was_shown = false

    -- actioncontrols 的 OnUpdate 会主动重新显示自己；参考 TMIR 增加持续隐藏守卫。
    ac._radial_wheel_hidden_by = ac._radial_wheel_hidden_by or {}
    if not ac._radial_wheel_hide_guard then
        ac._radial_wheel_hide_guard = true
        local old_actioncontrols_update = ac.OnUpdate
        ac.OnUpdate = function(actioncontrols, ...)
            if next(actioncontrols._radial_wheel_hidden_by or {}) ~= nil then
                actioncontrols:Hide()
                return
            end
            if old_actioncontrols_update ~= nil then
                return old_actioncontrols_update(actioncontrols, ...)
            end
        end
    end

    local function SetActionControlsHidden(hidden)
        if not RADIAL_WHEEL_CONFIG.hide_action_buttons_while_open then return end
        if hidden then
            actioncontrols_was_shown = ac.shown == true
            ac._radial_wheel_hidden_by[RADIAL_WHEEL_CONFIG.rid] = true
            ac:Hide()
        else
            ac._radial_wheel_hidden_by[RADIAL_WHEEL_CONFIG.rid] = nil
            if actioncontrols_was_shown
                and next(ac._radial_wheel_hidden_by) == nil
                and (ac.inst == nil or ac.inst:IsValid()) then
                ac:Show()
            end
            actioncontrols_was_shown = false
        end
    end

    local function IsEditMode()
        return ac._edit_mode_active == true
            or (TheFrontEnd ~= nil and TheFrontEnd.editmode == true)
    end

    local function EnsureWheel()
        if wheel == nil and ThePlayer ~= nil and ThePlayer.HUD ~= nil and ThePlayer.HUD.overlayroot ~= nil then
            wheel = ThePlayer.HUD.overlayroot:AddChild(RadialWheel())
        end
        return wheel
    end

    local function MoveVirtualTouch(delta_x, delta_y)
        local next_x = virtual_x + (delta_x or 0)
        local next_y = virtual_y + (delta_y or 0)
        local distance = math.sqrt(next_x * next_x + next_y * next_y)
        if distance > WHEEL_MAX_RADIUS then
            local scale = WHEEL_MAX_RADIUS / distance
            next_x, next_y = next_x * scale, next_y * scale
        end
        virtual_x, virtual_y = next_x, next_y
    end

    local function UpdateSelection()
        if wheel == nil or not wheel.shown then return end
        local dx, dy = virtual_x, virtual_y
        wheel:SetVirtualTouch(dx, dy)
        local distance = math.sqrt(dx * dx + dy * dy)
        -- Slots are placed from 12 o'clock clockwise; match the same angular direction.
        local degrees = 90 - math.deg(math.atan2(dy, dx))
        if degrees < 0 then degrees = degrees + 360 end
        local outer_count, inner_count = #wheel.outer, #wheel.inner
        local selected = -1
        if distance >= CENTER_RADIUS and inner_count > 0 and distance < INNER_RADIUS + 30 then
            -- Each button owns half of the sector on its left and right.
            local sector = 360 / inner_count
            selected = outer_count + (math.floor((degrees + sector * .5) / sector) % inner_count) + 1
        elseif distance >= CENTER_RADIUS and outer_count > 0 and distance < OUTER_RADIUS + 45 then
            -- The slot at 12 o'clock is centered on 12 o'clock, not on a boundary.
            local sector = 360 / outer_count
            selected = (math.floor((degrees + sector * .5) / sector) % outer_count) + 1
        end
        wheel:SetHighlight(selected)
    end

    -- 模拟一次完整的原始按键：按下 -> 松开。
    -- 必须走 Input:OnRawKey，让 onkey、onkeydown、onkeyup 与真实键盘保持一致；
    -- 不直接调用捕获到的回调 fn。
    local function TriggerKey(key)
        if key == nil or TheInput == nil or TheInput.OnRawKey == nil then return end
        Log("SimulateKey key=" .. tostring(key) .. " name=" .. KeyName(key))
        TheInput:OnRawKey(key, true)
        TheInput:OnRawKey(key, false)
    end

    local function TriggerOption(option)
        if option == nil then return end
        if type(option.key) == "number" then
            Log("Trigger key=" .. tostring(option.key))
            TriggerKey(option.key)
        elseif type(option.fn) == "function" then
            Log("Trigger fn label=" .. tostring(option.label))
            option.fn(controls, option)
        else
            Log("option has no key/fn")
        end
    end

    local function Finish(trigger)
        Log("Finish trigger=" .. tostring(trigger))
        if not holding then return end
        holding = false
        local option = trigger and wheel ~= nil and wheel:GetSelectedOption() or nil
        if wheel ~= nil then wheel:Close() end
        SetActionControlsHidden(false)
        TriggerOption(option)
        touch_id, last_touch_x, last_touch_y = nil, nil, nil
        last_global_move_id, last_global_move_x, last_global_move_y = nil, nil, nil
        virtual_x, virtual_y = 0, 0
    end

    -- 用全局触摸监听跟踪已认领的触点，手指移出按钮后仍能继续操作；只按 touch id 过滤。
    if TheInput ~= nil then
        TheInput:AddTouchMoveHandler(function(id, x, y)
            if holding and touch_id == id then
                MoveVirtualTouch(x - (last_touch_x or x), y - (last_touch_y or y))
                last_touch_x, last_touch_y = x, y
                last_global_move_id, last_global_move_x, last_global_move_y = id, x, y
                UpdateSelection()
            end
        end)
        TheInput:AddTouchEndHandler(function(id, x, y)
            if holding and touch_id == id then
                MoveVirtualTouch(x - (last_touch_x or x), y - (last_touch_y or y))
                last_touch_x, last_touch_y = x, y
                last_global_move_id, last_global_move_x, last_global_move_y = id, x, y
                UpdateSelection()
                Finish(true)
            end
        end)
        TheInput:AddTouchCancelHandler(function(id)
            if holding and touch_id == id then
                Finish(false)
            end
        end)
    end

    -- 主按钮只负责认领呼出轮盘的触点；移动和结束由上面的全局监听跟踪。
    local old_button_touch_start = button.OnTouchStart
    local old_button_touch_move = button.OnTouchMove
    local old_button_touch_end = button.OnTouchEnd
    local old_button_touch_cancel = button.OnTouchCancel

    button.OnTouchStart = function(self, id, x, y)
        if id == nil and TheInput ~= nil then
            id = TheInput.touchDownID
        end
        local editing = IsEditMode()
        Log("button OnTouchStart id=" .. tostring(id) .. ", editmode=" .. tostring(editing))
        if not editing and not holding then
            local current = EnsureWheel()
            if current ~= nil then
                holding = true
                touch_id = id
                last_touch_x, last_touch_y = x, y
                virtual_x, virtual_y = 0, 0
                Log("Open wheel, touch_id=" .. tostring(touch_id) .. ", keys=" .. tostring(#REGISTERED_KEYS))
                current:Open(REGISTERED_KEYS, RADIAL_WHEEL_CONFIG)
                UpdateSelection()
                SetActionControlsHidden(true)
                -- 本按钮只消费呼出轮盘的这一根手指，不再把事件传给父级。
                -- 只记录当前触摸 id，不会认领移动轮盘使用的其他触点。
                return true
            else
                Log("EnsureWheel nil")
            end
        end
        -- 编辑模式或未能打开轮盘时，保留按钮原有处理逻辑。
        if old_button_touch_start ~= nil then
            return old_button_touch_start(self, id, x, y)
        end
    end

    button.OnTouchMove = function(self, id, x, y)
        if holding and touch_id == id then
            if last_global_move_id ~= id or last_global_move_x ~= x or last_global_move_y ~= y then
                MoveVirtualTouch(x - (last_touch_x or x), y - (last_touch_y or y))
                last_touch_x, last_touch_y = x, y
                UpdateSelection()
            end
            -- 移动由全局监听按 touch id 过滤，避免同一事件累计两次位移。
            return true
        end
        if old_button_touch_move ~= nil then
            return old_button_touch_move(self, id, x, y)
        end
    end

    button.OnTouchEnd = function(self, id, x, y)
        if holding and touch_id == id then
            if last_global_move_id ~= id or last_global_move_x ~= x or last_global_move_y ~= y then
                MoveVirtualTouch(x - (last_touch_x or x), y - (last_touch_y or y))
                last_touch_x, last_touch_y = x, y
                UpdateSelection()
                Finish(true)
            end
            return true
        end
        if old_button_touch_end ~= nil then
            return old_button_touch_end(self, id, x, y)
        end
    end 

    button.OnTouchCancel = function(self, id)
        if holding and touch_id == id then
            Finish(false)
            return true
        end
        if old_button_touch_cancel ~= nil then
            return old_button_touch_cancel(self, id)
        end
    end

    button:SetOnClick(function()
        if holding and not TheInput:IsTouchDown() then Finish(true) end
    end)
end

-- 入口：controls 初始化时安装 hooks + 创建按钮
AddClassPostConstruct("widgets/controls", function(controls)
    controls._radial_wheels_added = controls._radial_wheels_added or {}
    if controls._radial_wheels_added[RADIAL_WHEEL_CONFIG.rid] then
        Log("already added, skip")
        return
    end
    controls._radial_wheels_added[RADIAL_WHEEL_CONFIG.rid] = true
    InstallKeyHooks()
    CreateRadialWheelButton(controls)
    Log("controls initialized")
end)

InstallKeyHooks()
Log("module load end")
