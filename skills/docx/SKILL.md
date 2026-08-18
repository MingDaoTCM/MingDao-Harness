---
name: docx
description: 创建、读取、编辑 Word 文档（.docx）时使用
---

# Word 文档处理

## 工具选择

| 场景 | 工具 |
| --- | --- |
| 读写段落/表格/样式 | `python-docx` |
| 格式转换 | `pandoc`（docx ↔ md ↔ pdf） |
| 转 PDF | `libreoffice --headless --convert-to pdf` |
| 只读提取文本 | `docx2txt` |

## 常用模式

1. **生成文档**：先建样式骨架（标题层级、正文字体），再逐段填充；表格用 `document.add_table`。
2. **读取**：遍历 `document.paragraphs` 与 `document.tables`，按需抽取标题层级。
3. **模板填充**：复制模板 docx，用 `{{占位符}}` 替换。
4. **修改已有文档**：python-docx 打开 → 修改 → 另存，不要手工拼 XML。

## 要点

- 首次使用先 `pip install python-docx`
- 生成后校验：重开文件统计段落/表格数，确认无损坏
- 中文场景检查字体设置（宋体/黑体），避免导出后乱码
