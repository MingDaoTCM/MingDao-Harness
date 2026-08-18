---
name: webapp-testing
description: 测试本地 Web 应用/服务（接口、页面、报错）时使用
---

# Web 应用测试

## 分层测试

### 接口层（curl，零依赖）

- 状态码/响应体/重定向：`curl -sS -i http://localhost:PORT/path`
- 常见断言：200/201/204、JSON 字段存在、错误格式统一
- 写脚本循环检查健康端点，最多重试 N 次，每次间隔 1s

### 浏览器层（Playwright）

- 首次使用：`pip install playwright && playwright install chromium`
- 无头模式：打开页面 → 截图 → 断言选择器文本 → 收集 console 错误
- 交互流程：点击、填表、等待元素出现（`wait_for_selector`）

## 纪律

1. **启动即负责**：自己起的服务进程，测试完必须杀掉（记录 PID）。
2. 先确认服务真的起来了（健康检查轮询），再断言业务。
3. 失败时保留现场：截图、响应体、日志一起给用户。
4. 端口冲突先 `lsof -i :PORT` / `netstat -ano` 排查。
