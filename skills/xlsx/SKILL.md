---
name: xlsx
description: 处理 Excel 表格（.xlsx/.xls/.csv）数据：读取、统计、清洗、生成报表时使用
---

# Excel 表格处理

## 工具选择

| 场景 | 工具 |
| --- | --- |
| 单元格级读写、格式、公式 | `openpyxl` |
| 批量统计/清洗/透视（数据思维） | `pandas` |
| 简单 CSV | 标准库 `csv`（零依赖） |
| 大文件（>100MB） | openpyxl `read_only` 模式，或 pandas 分块读取 |

## 工作流

1. 先探明结构：读表头与前 5 行，确认列名、空值、类型。
2. 用 pandas 做统计：分组、透视、去重、缺失值统计，输出关键结论而非全量数据。
3. 生成结果写新文件（不要覆盖原始数据），并校验行数。
4. CSV 编码坑：中文优先 `utf-8-sig`（Excel 兼容）。

## 要点

- 首次使用先 `pip install openpyxl pandas`
- 大文件先 `wc -l` 估算规模再决定工具
- 数值列注意空字符串/文本型数字，统计前先 `pd.to_numeric(errors='coerce')`
