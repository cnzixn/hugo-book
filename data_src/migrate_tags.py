"""
从 ds_pan.yml / dst_pan.yml 的旧 name 格式（tag.name）中提取标签，
迁移为新版 - tags: 字段，同时更新 name 去掉 tag 前缀。

用法：python migrate_tags.py
默认处理 hugo-book/data/ds_pan.yml 和 dst_pan.yml
"""
import os
import re
import sys


# 不引入 PyYAML，纯文本解析（格式固定，手动处理更稳）
def migrate_file(filepath):
    """迁移单个 YAML 文件中的旧 tag.name 格式"""
    if not os.path.exists(filepath):
        print(f"  [跳过] 文件不存在: {filepath}")
        return 0, 0

    with open(filepath, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    new_lines = []
    modified = 0
    already = 0
    i = 0
    total = len(lines)

    while i < total:
        line = lines[i]

        # 匹配 ID 头：任何以冒号结尾的非空行都视为 key
        id_match = re.match(r'^(.+?):\s*$', line)
        if not id_match:
            new_lines.append(line)
            i += 1
            continue

        # 收集该 ID 下的所有 - 字段
        entry_lines = [line]
        i += 1
        name_line = None
        tags_line_exists = False

        while i < total and not re.match(r'^.+?:\s*$', lines[i]):
            if lines[i].startswith('- name:'):
                name_line = lines[i]
            elif lines[i].startswith('- tags:'):
                tags_line_exists = True
            entry_lines.append(lines[i])
            i += 1

        # 如果没有 name 行或已存在 tags，跳过
        if name_line is None:
            new_lines.extend(entry_lines)
            continue

        if tags_line_exists:
            already += 1
            new_lines.extend(entry_lines)
            continue

        # 解析 name 内容：- name: 调整.箱子XL
        name_content = name_line.strip()[len('- name:'):].strip()

        # 只处理第一个 `.` 作为分隔符（避免误拆 mod 英文名里的点号如 v1.2）
        # 规则：tag 通常是 2-4 个中文字，用第一个 `.` 分割
        sep_idx = name_content.find('.')
        if sep_idx <= 0 or sep_idx >= len(name_content) - 1:
            # 没找到点号，或者在首/末尾，不迁移
            new_lines.extend(entry_lines)
            continue

        old_tag = name_content[:sep_idx].strip()
        new_name = name_content[sep_idx + 1:].strip()

        # tag 至少 2 个字符才算有效（避免把版本号 v1.2 拆了）
        if len(old_tag) < 2:
            new_lines.extend(entry_lines)
            continue

        # 找到 name 在 entry_lines 里的位置
        name_idx_in_entry = None
        for j, el in enumerate(entry_lines):
            if el.startswith('- name:'):
                name_idx_in_entry = j
                break

        if name_idx_in_entry is None:
            new_lines.extend(entry_lines)
            continue

        # 更新 name 行 + 在其后插入 tags 行
        entry_lines[name_idx_in_entry] = f'- name: {new_name}\n'
        entry_lines.insert(name_idx_in_entry + 1, f'- tags: {old_tag}\n')
        modified += 1

        new_lines.extend(entry_lines)

    # 写回
    with open(filepath, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)

    print(f"  [完成] {os.path.basename(filepath)}: 迁移 {modified} 条，已有 tags {already} 条")
    return modified, already


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # data_dir = os.path.normpath(os.path.join(script_dir, '..', 'data'))
    data_dir = os.path.normpath(os.path.join(script_dir))

    files = [
        os.path.join(data_dir, 'ds_pan.yml'),
        os.path.join(data_dir, 'dst_pan.yml'),
    ]

    total_modified = 0
    for fp in files:
        print(f"\n处理: {fp}")
        m, a = migrate_file(fp)
        total_modified += m

    print(f"\n总计迁移 {total_modified} 条")


if __name__ == '__main__':
    main()
