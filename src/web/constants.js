// 前端 + 服务端共享常量（零依赖纯 ESM，浏览器与 Node 均可 import）。
// 单源化（v0.2.8 B2）：附件上限 / 并发上限等数值只在此定义，
// 防 app.js（客户端预检）/ attachments.js（服务端校验）/ fs-tools.js（读取上限）漂移。
export const MAX_CONCURRENT = 8; // 并发任务上限（server 与任务面板共用）
export const MAX_ATTACHMENTS = 4; // 单次最多附件数
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 单张图片原图上限（5MB）
export const MAX_IMAGE_DATAURL = 7 * 1024 * 1024; // base64 膨胀 1.33 倍后的 dataURL 上限（≈5MB 原图）
export const MAX_TEXT_BYTES = 200 * 1024; // 文本附件上限（200KB）
export const MAX_FILE_READ_BYTES = 5 * 1024 * 1024; // read/edit 工具单文件读取上限（独立语义，非附件上限）
