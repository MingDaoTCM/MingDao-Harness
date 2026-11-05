// v0.7.0 §1.5：从 server.js 切出，行为不变。
//
// Provider 实例缓存（H-04）+ 本地端点预检备忘（v0.6.13 探针误报修复）的**单一实现**。
// 工厂依赖全部注入（`resolveProviderConfig` / `createProvider` / `probeEndpoint` / 日志…），
// 因此本模块可离线单测，不读 `config.json`、不发网络请求、不碰 `process`。
import crypto from 'node:crypto';

/**
 * 创建 Provider 缓存/预检运行时。
 *
 * @param {{
 *   cfg: any,
 *   log?: (line: string) => void,
 *   warn?: (line: string) => void,
 *   resolveProviderConfig: (cfg: any, model: string) => any,
 *   createProvider: (cfg: any, model: string) => Promise<any>,
 *   probeEndpoint?: (cfg: any, model: string, opts: { timeoutMs: number }) => Promise<any>,
 *   probeMemoUsable?: (memo: any) => boolean,
 *   adaptiveTimeouts?: (input: any) => { firstTokenMs: any, basis: any },
 *   isLocalBaseUrl?: (baseUrl: any) => boolean,
 *   setLocalQueueObserver?: ((fn: (ev: any) => void) => void) | null,
 * }} deps
 */
export function createProviderCache({
  cfg,
  log = () => {},
  warn = () => {},
  resolveProviderConfig,
  createProvider,
  probeEndpoint = async () => null,
  probeMemoUsable = () => false,
  adaptiveTimeouts = () => ({ firstTokenMs: null, basis: '' }),
  isLocalBaseUrl = () => false,
  setLocalQueueObserver = null,
}) {
  const providerCache = new Map();
  // v0.6.13（A 追加）：本地端点的**能力/延迟预检**结果（每次建 provider / 每轮对话开头的提示都读它）。
  // 只对"本地端点"做：远程服务商不需要（也不该）每次开聊都多打一次请求。
  //
  // v0.6.13（探针误报修复）——这里的备忘**必须有 TTL，且失败结论只保鲜 60s**：
  //   真机误报的根因就是它此前**没有任何 TTL**：进程启动时引擎没起来 → 备忘里留下
  //   「❌ 不可达：fetch failed（本地引擎没起来？先确认端口/进程）」→ 之后每个新回合原样重放
  //   （web-server.log:413 07:03:02 那次真实探测 → :416 07:08:13 / :799 10:13:58 两次重放，
  //   相隔 **7h10m**；10:13:58.877 `chat 开始` → .900 `chat 预检`只差 **23ms**、且没有 `预检 <模型>` 行，
  //   正是"没重测、直接念旧结论"），而同一回合其实完全可用（:803 首帧 8.7s、:844 已跑 21m）。
  //   结论：`probeMemoUsable()` 判保鲜期（成功 10 分钟 / 失败 60s），过期就重测。
  const probeByModel = new Map();
  // v0.6.29（审计报告 H-04）：**Provider 缓存必须按"出网配置指纹"分代**。
  //
  // 原实现 `providerCache` 只按模型名缓存，切换 baseUrl 时若某条路径忘了 `clear()`（setBaseUrl 就是），
  // 旧实例的 chat 闭包会继续用**创建时固化**的 baseUrl/apiKey 出网——界面显示已切到 B，
  // 实际主回答、自动标题、记忆提取仍把正文和 `Authorization: Bearer …` 发给 A（报告实测 A 收到 10 次）。
  //
  // 这里把「代际号 + baseUrl + 凭证摘要 + 超时配置」纳入缓存键，并让 `invalidateProviderCache()`
  // 同时清 provider 与预检备忘：**新任务永远拿不到旧代际实例**；已经开始的旧任务仍持旧实例自然结束
  // （不强行中断，避免打断用户正在看的回答）。
  let providerGeneration = 0;
  /** 出网配置指纹：apiKey 只取 sha256 摘要（不进 Map 键、不落日志）。 */
  const providerFingerprint = (/** @type {string} */ m) => {
    const pc = resolveProviderConfig(cfg, m) || {};
    const keyDigest = crypto.createHash('sha256').update(String(pc.apiKey || '')).digest('hex').slice(0, 16);
    let timeout = '';
    try {
      timeout = JSON.stringify(cfg?.timeout ?? null);
    } catch {
      timeout = '';
    }
    return `${providerGeneration}\u0000${String(pc.baseUrl || '')}\u0000${keyDigest}\u0000${timeout}`;
  };
  /** @param {string} m */
  const providerCacheKey = (m) => `${m}\u0000${providerFingerprint(m)}`;
  /** @param {string} m */
  const probeCacheKey = (m) => `${m}\u0000${providerFingerprint(m)}`;
  /**
   * 配置代际失效：provider 实例 + 本地端点预检备忘一起清。
   * 预检结果含 endpoint/TTFT，旧端点的结论绝不能套到新端点上（否则自适应超时也会跟着错代际）。
   * @param {string} [reason]
   */
  const invalidateProviderCache = (reason = '配置变更') => {
    providerGeneration += 1;
    const instances = providerCache.size;
    const probes = probeByModel.size;
    providerCache.clear();
    probeByModel.clear();
    try {
      log(`provider 代际 ${providerGeneration}：${reason}（清实例 ${instances} / 预检备忘 ${probes}）`);
    } catch {}
  };
  /** 该模型是否属于"本地端点"（baseUrl 是回环/内网，或 customModels 显式声明 local:true）。 */
  const isLocalModel = (/** @type {string} */ m) => {
    try {
      const pc = resolveProviderConfig(cfg, m) || {};
      return isLocalBaseUrl(pc.baseUrl) || cfg?.customModels?.[m]?.local === true || cfg?.customModels?.[m]?.isLocal === true;
    } catch {
      return false;
    }
  };
  /**
   * 取（或首次执行）预检。
   *
   * **探针是尽力而为：失败只降级、不阻断**（本函数自己吞掉异常 → 返回 null → 调用方按既有默认继续；
   * 回合发起绝不受预检影响）。这里的"降级"有三层：
   *   ① 探针抛错 → 吞掉（下面 try/catch），只是"没有预检数据"；
   *   ② 探针判"不可达/超时" → 仍然照常开工（状态只用于 banner/日志/自适应超时）；
   *   ③ 探针慢 → 单次尝试 1.5s + 退避 + 总预算 15s 封顶（见 probeEndpoint），不会把回合发起拖成几十秒。
   * @param {string} m
   */
  async function ensureProbe(m) {
    const pk = probeCacheKey(m); // 与 provider 同代际：切端点后旧预检结论立即失效
    const memo = probeByModel.get(pk);
    if (probeMemoUsable(memo)) return memo.value;
    if (!isLocalModel(m)) return null;
    /** @type {any} */
    let probe = null;
    try {
      probe = await probeEndpoint(cfg, m, { timeoutMs: 15000 });
      // v0.6.13（问题 2）：这行日志此前用 `probe.toolCalls` 判工具支持——该字段**从来不存在**
      // （真机日志里恒为 `tools=未知`，见 web-server.log:48/169/303），预检结论等于没落日志。
      // 现在取真实的四态 toolState，并把**引擎自述上下文 vs 配置**也写进来。
      const toolText =
        probe.toolState === 'stable-tools'
          ? `支持（${probe.toolCallHits}/${probe.toolCallRuns}）`
          : probe.toolState === 'unstable-tools'
            ? `不稳定（${probe.toolCallHits}/${probe.toolCallRuns}）`
            : probe.toolState === 'no-tools'
              ? `不返回 tool_calls（${probe.toolCallHits}/${probe.toolCallRuns}）`
              : '未知/不可判定';
      log(
        `预检 ${m} ${probe.state}${probe.reason ? ` reason=${probe.reason}` : ''} ttft=${probe.ttftMs == null ? 'n/a' : Math.round(probe.ttftMs) + 'ms'} ` +
          `prefill2000=${probe.prefillMs == null ? 'n/a' : Math.round(probe.prefillMs) + 'ms'} ` +
          `tools=${toolText} endpoint=${probe.endpoint || '（无）'} ` +
          `引擎自述上下文=${probe.engineCtx == null ? '未读到' : probe.engineCtx} 配置=${probe.configuredWindow ?? '？'}`
      );
    } catch (/** @type {any} */ e) {
      log(`预检 ${m} 失败（忽略，按默认超时继续）：${String(e?.message || e)}`);
    }
    probeByModel.set(pk, { at: Date.now(), value: probe });
    if (probeByModel.size > 50) probeByModel.delete(probeByModel.keys().next().value);
    return probe;
  }
  /** @param {string} m */
  async function getProviderFor(m) {
    // H-04：缓存键 = 模型 + 出网配置指纹 + 代际号。配置一变，新任务自然落到新键；
    // 即便某个调用方忘了 clear，也不会复用旧实例（两层保险，clear/代际另有一层）。
    const cacheKey = providerCacheKey(m);
    if (!providerCache.has(cacheKey)) {
      // 建 provider 之前先预检：本地端点按实测 TTFT 自适应 config.timeout.firstTokenMs
      // （providers/index.js 只认 cfg.timeout，因此这里把自适应值**合进 cfg**再建实例）。
      // 取舍：用户显式配的 firstTokenMs 优先；没配时"地板"仍是既有默认（本地 600s），
      // 只有实测很慢才会放宽（×20，封顶 1800s）——绝不比现状更激进。
      let cfgForProvider = cfg;
      try {
        const probe = await ensureProbe(m);
        if (probe) {
          const adapt = adaptiveTimeouts({
            probeTtftMs: probe.ttftMs,
            probePrefillMs: probe.prefillMs,
            isLocal: true,
            timeoutCfg: cfg.timeout,
            noProgressCfg: cfg.noProgressTimeoutMs,
          });
          cfgForProvider = { ...cfg, timeout: { ...(cfg.timeout || {}), firstTokenMs: adapt.firstTokenMs } };
          log(`预检自适应 ${m} firstTokenMs=${adapt.firstTokenMs}（${adapt.basis}）`);
        }
      } catch {}
      const created = await createProvider(cfgForProvider, m);
      // 创建期间配置又变了：这个实例属于旧代际，**不写回缓存**（否则新任务可能拿到它）。
      // 发起它的旧任务照常拿到 `created` 并自然结束——不强杀在途回合。
      if (providerCacheKey(m) === cacheKey) {
        providerCache.set(cacheKey, created);
        if (providerCache.size > 32) providerCache.delete(providerCache.keys().next().value);
      }
      return created;
    }
    return providerCache.get(cacheKey);
  }
  /** 诊断读数（只读；供测试/排障，不参与判定）。 */
  const stats = () => ({ instances: providerCache.size, probes: probeByModel.size, generation: providerGeneration });
  /**
   * 启动预热（旧 `runWebServer` 里 366–371 + 384–388 + 527 三段的等价物）：
   *   ① 未配置 API Key 的告警（界面照常可用，不阻塞启动）；
   *   ② 本地端点串行化日志接到 `log`（真机取证靠 web-server.log）；
   *   ③ 首个 provider 的创建（含预检/自适应超时）。
   * 顺序与切分前一致：告警 → 观察者 → 建 provider。
   * @param {string} initialModel
   * @returns {Promise<{ provider: any, providerCache: Map<string, any>, invalidateProviderCache: (reason?: string) => void, getProviderFor: (m: string) => Promise<any>, ensureProbe: (m: string) => Promise<any>, providerFingerprint: (m: string) => string, stats: () => { instances: number, probes: number, generation: number } }>}
   */
  async function start(initialModel) {
    const pc = resolveProviderConfig(cfg, initialModel) || {};
    if (!pc.apiKey) {
      // 首次运行/未配置密钥：界面照常启动（黑屏根因修复——此前这里直接 return，桌面版窗口
      // 加载不到任何服务 → 整窗黑屏且无提示）。⚙ 设置里填入 Key 后即可对话。
      warn(`[MingDao] ⚠ 未配置 ${initialModel} 的 API Key：界面可正常使用，对话前请在 ⚙ 设置 →「模型与 API Key」填入密钥。`);
    }
    if (setLocalQueueObserver) {
      // v0.6.15（§3.59）：本地端点串行化的日志必须落进 web-server.log（真机取证靠它），
      // 而不是只打到 stderr。事件由 providers/index.js 的本地端点闸门在**入队时**发出（含在途数/并发上限）。
      setLocalQueueObserver((ev) => {
        try {
          log(`${String(ev?.text || '本地端点串行化')}${ev?.label ? `（模型 ${ev.label}）` : ''}`);
        } catch {}
      });
    }
    const provider = await getProviderFor(initialModel);
    return { provider, providerCache, invalidateProviderCache, getProviderFor, ensureProbe, providerFingerprint, stats };
  }
  return { providerCache, invalidateProviderCache, getProviderFor, ensureProbe, providerFingerprint, stats, start };
}
