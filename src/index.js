// MingDao-Harness 公共 API：供第三方程序/插件以库形式复用核心能力。
// 稳定性契约（v0.4.0 起）：@stable 在 minor 版本内保持向后兼容；@experimental 可能变更。
// 详细契约与示例见 docs/DEVELOPER.md。

// —— @stable：Agent 内核 ——
export { createAgent } from './agent.js';
export { createPermission } from './permissions.js';
export { createIO, style, C } from './ui.js';

// —— @stable：Provider 与模型 ——
export { createProvider, resolveProviderConfig } from './providers/index.js';
export { MODELS, PROVIDERS, modelPreset, providerPreset } from './models.js';
export { resolveModelCaps, safeBudget, isLocalBaseUrl } from './model-caps.js';

// —— @stable：工具（含 v0.4.0 第三方注册）——
export { toolSchemas, dispatch, registerTool, listRegisteredTools, mountConfigTools, buildToolSchemas } from './tools/index.js';

// —— @stable：Agent Preset（v0.4.0）——
export {
  listPresets,
  loadPreset,
  validatePreset,
  presetConfigOverrides,
  presetSystemBlock,
  presetDirs,
} from './presets.js';

// —— @stable：上下文与压缩 ——
export { trimMessages, approxTokens, clampText, TOOL_RESULT_LIMIT } from './context.js';
export { compactConversation, summarizeConversation } from './compact.js';

// —— @stable：配置与凭证 ——
export {
  mingdaoHome,
  ensureHome,
  loadConfig,
  saveConfig,
  runWizard,
  effectiveApiKey,
} from './config.js';
export {
  credentialsPath,
  loadCredentials,
  saveCredentials,
  getStoredKey,
  setStoredKey,
  removeStoredKey,
  maskKey,
  resolveApiKey,
} from './credentials.js';

// —— @stable：计价与计量 ——
export { estimateCost, estimateCostLabel, isPeakHour, PRICE_DATA_AS_OF } from './pricing.js';
export { countTokens, heuristicTokens, makeTokenCounter, isTokenizable } from './tokenizer.js';

// —— @experimental：更新/审计/技能/会话（接口可能调整）——
export { updateCheck, mingdaoUpdate, mingdaoRollback, findRepoRoot } from './update.js';
export { writeAudit, listAudit, redactSecrets, auditFile } from './audit.js';
export { trustSkill, skillDirHash, readSourceMeta } from './skill-lib.js';
export { tamperedSkillNames } from './skills.js';
export { McpClient, startMcpServers } from './mcp.js';
export {
  createSession,
  latestSession,
  listSessions,
  appendMessages,
  loadSession,
} from './session.js';
