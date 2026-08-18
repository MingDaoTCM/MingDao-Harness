---
name: pdf
description: 读取、解析、生成、合并、拆分 PDF 文件时使用
---

# PDF 处理

## 场景 → 工具

| 场景 | 推荐 |
| --- | --- |
| 提取文本（速度优先） | `pymupdf`（fitz） |
| 提取表格 | `pdfplumber`（表格识别强） |
| 纯命令行提取 | `pdftotext` / `pdfinfo`（poppler-utils） |
| 合并/拆分/旋转/加水印 | `pypdf` |
| 程序生成报表 | `reportlab` |
| 扫描件（无文本层） | OCR：`tesseract` + `pdf2image` |

## 工作流

1. **先探测环境**：`python -c "import fitz"` 等确认依赖，缺什么 `pip install pymupdf`。
2. 大文件先看页数：`pdfinfo file.pdf` 或用 fitz 统计，避免一次性读入内存。
3. 输出结果写回文件（write 工具）或直接打印关键数据，附上页码范围。
4. 校验：合并后重开验证页数；提取后抽查文本。

## 常见坑

- 提取文本顺序混乱 → 用 `sort=True` 或按坐标排序
- 表格识别不准 → pdfplumber 的 `extract_tables` + 手动核对列
- 中文乱码 → 确认字体嵌入与编码（reportlab 用 CID 字体）
