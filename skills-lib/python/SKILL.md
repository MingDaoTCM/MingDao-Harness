---
name: python
description: Python 编码规范与最佳实践
---

# Python 编码规范

写/改/审查 Python 代码时使用。

## 规则

1. 风格遵循 PEP 8：4 空格缩进、行宽 ≤ 100、snake_case 命名。
2. 类型注解：函数签名写参数与返回类型；用 `pathlib` 处理路径、`dataclasses` 代替裸字典。
3. 现代语法：f-string 格式化、`with` 管理资源、异常只捕获具体类型（不裸 `except:`）。
4. 结构：纯函数优先、依赖注入便于测试；副作用集中在入口处。
5. 依赖：优先标准库；第三方包注明版本（pyproject.toml）。
6. 环境：虚拟环境 + `pyproject.toml`，兼容性注明 Python 最低版本。

## 检查点

- 不混用制表符；字符串编码显式 UTF-8；
- 可运行性优先：改动后给出运行/测试命令。

## 输出

代码 + 关键设计说明（为什么这样写）。
