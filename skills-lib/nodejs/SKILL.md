---
name: nodejs
description: Node.js/JavaScript 编码规范与最佳实践
---

# Node.js 编码规范

写/改/审查 Node.js 或前端 JavaScript 代码时使用。

## 规则

1. 现代语法：`const`/`let`（不用 `var`）、箭头函数、async/await 代替回调嵌套、模板字符串。
2. ESM 优先（`import`/`export`）；项目已有模块体系时保持一致。
3. 错误处理：异步调用用 try/catch，Promise 链有 catch；回调风格只在与旧库交互时用。
4. 安全：不 `eval` 用户输入、路径用 `path.join` 防穿越、`child_process` 用数组参数避免 shell 注入。
5. 结构：纯函数优先、单文件职责单一、配置外置（环境变量）。
6. 依赖克制：能用标准库就不用第三方包；锁定版本（lockfile）。

## 检查点

- 改动后给出运行/测试命令；
- 不依赖全局变量与隐式魔法，函数输入输出可预测。

## 输出

代码 + 关键设计说明。
