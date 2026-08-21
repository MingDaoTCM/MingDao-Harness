// 聊天附件构造（纯函数，便于测试）：
//  - 图片：仅视觉模型支持（内置预设 supportsVision 或自定义模型 vision:true），
//    转 data:image/...;base64 内联（JPEG/PNG/GIF/WebP，单张 ≤5MB，最多 4 个附件）
//  - 文本文件：直接拼接进消息文本（≤200KB），并留文件名标注
//  - 返回 { content（模型消息内容：字符串或图文数组）, persistText（落盘文本）, error }

const MAX_IMAGE_DATAURL = 7 * 1024 * 1024; // base64 膨胀 1.33 倍，对应约 5MB 原图
const MAX_TEXT = 200 * 1024;

export function buildUserContent(message, attachments, visionSupported) {
  const text = String(message ?? '').trim();
  const list = Array.isArray(attachments) ? attachments.slice(0, 4) : [];
  const imageParts = [];
  const persistParts = [];
  let finalText = text;
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'image') {
      const dataUrl = String(a.dataUrl || '');
      if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(dataUrl)) {
        return { error: `图片格式不支持：${a.name || '未命名'}（仅 JPEG/PNG/GIF/WebP）` };
      }
      if (dataUrl.length > MAX_IMAGE_DATAURL) {
        return { error: `图片过大：${a.name || '未命名'}（单张 ≤5MB）` };
      }
      if (!visionSupported) {
        return { error: '当前模型不支持图片输入（请切换到 deepseek-v4-flash-vision-exp 或支持视觉的自定义模型）' };
      }
      imageParts.push({ type: 'image_url', image_url: { url: dataUrl } });
      persistParts.push(`[图片：${a.name || '未命名'}]`);
    } else if (a.type === 'text') {
      const content = String(a.content ?? '');
      if (!content.trim()) continue;
      if (content.length > MAX_TEXT) {
        return { error: `文本文件过大：${a.name || '未命名'}（≤200KB）` };
      }
      finalText += `${finalText ? '\n\n' : ''}[文件 ${a.name || '未命名'}]\n${content}`;
      persistParts.push(`[文件：${a.name || '未命名'}]`);
    }
  }
  if (!finalText.trim() && !imageParts.length) {
    return { error: '消息与附件不能同时为空' };
  }
  // 有图片 → 图文数组；纯文本 → 字符串（保持普通路径不变）
  const content = imageParts.length
    ? [...(finalText.trim() ? [{ type: 'text', text: finalText }] : []), ...imageParts]
    : finalText;
  return { content, persistText: `${finalText.trim()}${persistParts.length ? (finalText.trim() ? '\n' : '') + persistParts.join(' ') : ''}`.trim() };
}
