local lfs = require("lfs")

local SEP = package.config:sub(1,1) -- 获取系统路径分隔符


-- 递归创建目录
local function mkdirs(path)
    local parts = {}
    for part in path:gmatch("[^"..SEP.."]+") do
        table.insert(parts, part)
        local subpath = table.concat(parts, SEP)
        local attr = lfs.attributes(subpath)
        if not attr then
            local ok, err = lfs.mkdir(subpath)
            if not ok then return nil, err end
        elseif attr.mode ~= "directory" then
            return nil, subpath .. " exists but is not a directory"
        end
    end
    return true
end

-- 小端序读取32位整数
local function read_uint32(file)
    local data = file:read(4)
    if not data or #data ~= 4 then return nil end
    local b1, b2, b3, b4 = data:byte(1,4)
    return b1 + b2*256 + b3*65536 + b4*16777216
end

-- 小端序写入32位整数
local function write_uint32(file, value)
    local b1 = value % 256
    value = math.floor(value / 256)
    local b2 = value % 256
    value = math.floor(value / 256)
    local b3 = value % 256
    value = math.floor(value / 256)
    local b4 = value % 256
    file:write(string.char(b1, b2, b3, b4))
end

-- 解包函数
local function unpack_archive(archive_path, output_dir)
    local file = io.open(archive_path, "rb")
    if not file then return nil, "Failed to open archive" end
    
    -- 检查文件标识
    local id = file:read(4)
    if id ~= "KLFA" then
        file:close()
        return nil, "Invalid archive format"
    end
    
    -- 读取文件数量
    local files = read_uint32(file)
    if not files then
        file:close()
        return nil, "Failed to read file count"
    end
    
    -- 读取文件索引
    local entries = {}
    for i = 1, files do
        local name_size = read_uint32(file)
        if not name_size then
            file:close()
            return nil, "Failed to read name size for file "..i
        end
        
        local name = file:read(name_size)
        if not name or #name ~= name_size then
            file:close()
            return nil, "Failed to read name for file "..i
        end
        
        -- 尝试将文件名从可能的UTF-8编码转换
        if not name:match("^[%w%./\\_%-]+$") then  -- 如果包含非ASCII字符
            local success, converted = pcall(function()
                return name:iconv("UTF-8", "UTF-8")  -- 尝试UTF-8转换
            end)
            if success and converted then
                name = converted
            end
        end
        
        local offset = read_uint32(file)
        if not offset then
            file:close()
            return nil, "Failed to read offset for file "..i
        end
        
        local size = read_uint32(file)
        if not size then
            file:close()
            return nil, "Failed to read size for file "..i
        end
        
        -- 跳过dummy byte
        file:read(1)
        
        -- 转换路径分隔符为系统格式
        name = name:gsub("[/\\]", SEP)
        table.insert(entries, {name = name, offset = offset, size = size})
    end
    
    -- 提取文件
    print(string.format("Found %d files to extract", #entries))
    for idx, entry in ipairs(entries) do
        if idx % 10 == 0 or idx == 1 or idx == #entries then
            print(string.format("[%d/%d] Extracting: %s", idx, #entries, entry.name))
        end
        local full_path = output_dir .. SEP .. entry.name
        local dir_path = full_path:match("(.*"..SEP..")")
        
        -- 创建目录
        if dir_path then
            local ok, err = mkdirs(dir_path)
            if not ok then
                file:close()
                return nil, "Failed to create directory: " .. err
            end
        end
        
        -- 写入文件
        file:seek("set", entry.offset)
        local data = file:read(entry.size)
        if not data or #data ~= entry.size then
            file:close()
            return nil, "Failed to read file data: " .. entry.name
        end

        -- 生成随机英文文件名（保留原扩展名）
        local function random_filename(original_path)
            -- 拆分路径和文件名（支持 / 分隔符）
            local path, name = original_path:match("(.*[/\\])(.*)")
            -- 如果没有路径（仅文件名），path 设为空
            if not path then
                path = ""
                name = original_path
            end
            
            -- 提取扩展名
            local ext = name:match("(%.[^%.]+)$") or ""
            -- 生成8位随机字符串
            local chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
            local random_str = ""
            for _ = 1, 8 do
                local rand = math.random(1, #chars)
                random_str = random_str .. chars:sub(rand, rand)
            end
            
            -- 拼接路径 + 新文件名 + 扩展名
            return path .. "FIX_" .. random_str .. ext
        end
        -- -- 测试：保留路径结构，只替换文件名
        -- print(random_filename("a/b/c/乱码.txt"))  -- 输出类似 "a/b/c/FIX_ZhvHjb6.txt"
        -- print(random_filename("test/文档.pdf"))    -- 输出类似 "test/FIX_8kLm2P9.pdf"
        -- print(random_filename("图片.png"))        -- 输出类似 "FIX_3QrT7s2.png"

        
        -- 在解包逻辑中修改文件创建部分
        local out
        local retry_count = 0
        local max_retries = 3  -- 最多重试3次
        
        repeat
            out = io.open(full_path, "wb")
            if not out and retry_count < max_retries then
                -- 如果失败且文件名含中文，生成随机英文名重试
                if full_path:match("[^%w%./\\_%-]") then
                    local new_name = random_filename(entry.name)
                    full_path = output_dir .. SEP .. new_name
                    print(string.format("Retry with random name: %s -> %s", entry.name, new_name))
                end
                retry_count = retry_count + 1
            else
                break
            end
        until retry_count >= max_retries
        
        if not out then
            file:close()
            return nil, "Failed to create file after retries: " .. full_path
        end
        out:write(data)
        out:close()
    end
    
    file:close()
    return true, files  -- 返回成功和文件数量
end

-- 主打包函数
local function pack_archive(input_dir, archive_path)
    -- 确保输入目录以分隔符结尾
    if input_dir:sub(-1) ~= SEP then
        input_dir = input_dir .. SEP
    end
    
    -- 收集文件列表（支持中文文件名）
    local file_list = {}
    local function scan_dir(dir)
        for entry in lfs.dir(dir) do
            if entry ~= "." and entry ~= ".." then
                if entry:sub(1,1) ~= "." then
                    local path = dir .. SEP .. entry
                    local attr = lfs.attributes(path)
                    if attr then
                        if attr.mode == "directory" then
                            scan_dir(path)
                        elseif attr.mode == "file" then
                            -- 正确处理相对路径（支持中文）
                            local rel_path = path:sub(#input_dir + 1)
                            -- 统一使用正斜杠作为内部路径分隔符
                            rel_path = rel_path:gsub("\\", "/")
                            -- 移除路径开头的斜杠（如果存在）
                            if rel_path:sub(1,1) == "/" then
                                rel_path = rel_path:sub(2)
                            end
                            -- 确保文件名以UTF-8格式存储
                            table.insert(file_list, {
                                full_path = path,
                                rel_path = rel_path,
                                size = attr.size,
                                raw_name = entry -- 保存原始文件名用于调试
                            })
                        end
                    end
                end
            end
        end
    end
    
    scan_dir(input_dir)
    local file_count = #file_list
    if file_count == 0 then return nil, "No files found" end
    
    -- 创建输出目录
    local archive_dir = archive_path:match("(.*"..SEP..")")
    if archive_dir then
        local ok, err = mkdirs(archive_dir)
        if not ok then return nil, "Failed to create archive dir: " .. err end
    end
    
    -- 以二进制模式打开输出文件
    local out, err = io.open(archive_path, "wb")
    if not out then return nil, "Failed to create archive file: " .. (err or "unknown error") end
    
    -- 写入文件头
    out:write("KLFA") -- 魔数标识
    write_uint32(out, file_count) -- 文件数量
    
    -- 计算数据区起始偏移
    local header_size = 8  -- "KLFA"(4) + file_count(4)
    for _, file in ipairs(file_list) do
        header_size = header_size + 4 + #file.rel_path + 4 + 4 + 1
    end
    
    -- 写入文件索引（支持中文文件名）
    print(string.format("Writing index for %d files", file_count))
    local current_offset = header_size
    for idx, file in ipairs(file_list) do
        if idx % 10 == 0 or idx == 1 or idx == file_count then
            print(string.format("[%d/%d] Indexing: %s", idx, file_count, file.rel_path))
        end
        
        -- 文件名长度（UTF-8字节长度）
        write_uint32(out, #file.rel_path)
        -- 文件名（直接写入UTF-8字节）
        out:write(file.rel_path)
        -- 文件偏移
        write_uint32(out, current_offset)
        -- 文件大小
        write_uint32(out, file.size)
        -- 保留字节（可用于未来扩展）
        out:write(string.char(0))
        
        current_offset = current_offset + file.size
    end
    
    -- 写入文件数据
    print(string.format("Writing data for %d files", file_count))
    for idx, file in ipairs(file_list) do
        -- 每10个文件或第一个/最后一个文件显示一次进度
        if idx % 10 == 0 or idx == 1 or idx == file_count then
            print(string.format("[%d/%d] Packing: %s (%.2f KB)", idx, file_count, file.rel_path, file.size/1024))
        end

        -- 以二进制模式读取文件
        local f, err = io.open(file.full_path, "rb")
        if not f then
            out:close()
            return nil, "Failed to open file: " .. file.full_path .. " (" .. (err or "unknown error") .. ")"
        end
        
        local data = f:read("*a")
        f:close()
        
        if #data ~= file.size then
            out:close()
            return nil, "File size mismatch: " .. file.full_path .. " (expected " .. file.size .. ", got " .. #data .. ")"
        end
        
        out:write(data)
    end
    
    out:close()
    return true, file_count  -- 返回成功和文件数量
end



-- 主程序
local function main()
    if #arg < 2 then
        print("Usage: lua klfa <input> <output>")
        print("  Auto-detect mode:")
        print("    If input is .archive and output is dir -> unpack")
        print("    If input is dir and output is .archive -> pack")
        print("Examples:")
        print("  Unpack: lua klfa data.archive output_dir")
        print("  Pack:   lua klfa input_dir data.archive")
        return
    end
    
    local input = arg[1]
    local output = arg[2]
    
    -- 标准化路径（去除结尾分隔符）
    input = input:gsub("[/\\]+$", "")
    output = output:gsub("[/\\]+$", "")
    
    -- 自动检测模式
    local mode
    if input:match("%.archive$") and not output:match("%.archive$") then
        mode = "unpack"
    elseif not input:match("%.archive$") and output:match("%.archive$") then
        mode = "pack"
    else
        print("\27[31mError: Cannot determine mode. Check input/output paths.\27[0m")
        print("  Input: " .. input)
        print("  Output: " .. output)
        os.exit(1)
    end
    
    -- 执行解包或打包
    if mode == "unpack" then
        local ok, count_or_err = unpack_archive(input, output)
        if not ok then
            print("\27[31mUnpack failed:", count_or_err, "\27[0m")
            os.exit(1)
        end
        print("\27[32m["..input.."] Unpack successfully! "..count_or_err.." files extracted\27[0m")
    else
        local ok, count_or_err = pack_archive(input, output)
        if not ok then
            print("\27[31mPack failed:", count_or_err, "\27[0m")
            os.exit(1)
        end
        print("\27[32m["..output.."] Pack successfully! "..count_or_err.." files packed\27[0m")
    end
end

-- 运行主程序
main()
