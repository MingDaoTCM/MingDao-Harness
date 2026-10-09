# Configuration reference (`~/.mingdao/config.json`)

> **Language policy.** Canonical docs are Chinese (`docs/CONFIG.md`). When this English file and the
> Chinese docs or the code disagree, **the code wins** — please open an issue.
>
> Every statement below was re-verified against the source tree at `package.json` **v0.6.10**
> (`src/config.js`, `src/permissions.js`, `src/tools/bash.js`, `src/net-guard.js`, `src/net-policy.js`,
> `src/audit.js`, `src/ledger.js`, `src/web/server.js`, `src/web/routes/api.js`, `src/cost-guard.js`,
> `src/constraints.js`, `src/packs.js`, `src/credentials.js`, `src/model-caps.js`, `src/hooks.js`).
> Where the Chinese document and the code disagree, the code's behaviour is written here and the
> difference is called out inline.

The configuration file contains **no secrets**. It is safe to share with a team and safe to commit.
API keys live in a separate credential store, `~/.mingdao/credentials.json` (mode `600`).

---

## Configuration file & precedence

### Location

| Thing | Path |
| --- | --- |
| Config file | `$MINGDAO_HOME/config.json`, default `~/.mingdao/config.json` |
| Credential store | `$MINGDAO_HOME/credentials.json` (mode `600`) |
| Tool-call audit log | `$MINGDAO_HOME/audit.jsonl` (mode `600`) |
| Session journal | `$MINGDAO_HOME/journal.jsonl` |
| Egress log | `$MINGDAO_HOME/net.jsonl` (mode `600`) |
| Execution ledgers | `$MINGDAO_HOME/ledger/<runId>.jsonl` + `.seal.json` (mode `700`) |
| Sessions / search index | `$MINGDAO_HOME/sessions/`, `$MINGDAO_HOME/sessions-index/` |
| Per-session workspace map | `$MINGDAO_HOME/session-workspaces.json` |
| Global memory | `$MINGDAO_HOME/memory.md` |
| Per-project memory | `<your project>/.mingdao/memory.md` (self-ignored, see below) |
| Custom provider modules | `$MINGDAO_HOME/providers/<name>.mjs` |

`MINGDAO_HOME` overrides the home directory for everything above (`src/config.js:mingdaoHome()`).

### Precedence

```
command-line arguments  >  environment variables  >  config.json  >  built-in provider/model presets
```

For the API key specifically the chain is a different one
(`src/credentials.js:resolveApiKey`):

```
<provider>_API_KEY or MINGDAO_API_KEY  >  credentials.json  >  config.json "apiKey" (legacy fallback)
```

`config.apiKey` is still **read** for backwards compatibility, but nothing writes it any more. Use
`mingdao key set <provider>` or the WebUI settings panel.

### Safety properties of the reader/writer

* **Writes are atomic**: `saveConfig` uses `atomicWriteFileSync` (tmp file + `rename`) and then
  `chmod 0600` (`src/config.js:saveConfig`).
* **A config that cannot be read is never silently overwritten.** `readConfigStrict()` distinguishes
  "does not exist" from "exists but is unreadable" (bad JSON, BOM, wrong type, permissions).
  Unreadable files are **renamed** to `config.json.corrupt-<timestamp>` (suffixed `-1`, `-2`, … if two
  corruptions happen in the same second), then the caller continues with a fresh object and a loud
  warning telling you to merge `customModels` / `mcpServers` / `sync` / `net` / `costGuard` back by hand.
  A UTF-8 BOM is tolerated (stripped before `JSON.parse`).

### What first run actually writes

`ensureMinimalConfig()` (desktop first run) creates exactly six fields:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "baseUrl": "https://api.deepseek.com/v1",
  "permission": "ask",
  "sandbox": "off",
  "contextBudget": 128000
}
```

Nothing else is implied — in particular **no** `net`, `costGuard`, `web`, `sync`, `hooks`, `packs`,
`mcpServers` or `customModels` object is created. `model` is `DEFAULT_MODEL` (`deepseek-flash`) and
`baseUrl` comes from the `deepseek` provider preset. The interactive `mingdao init` wizard writes a
similar minimal set plus optional `routing`.

---

## Model & providers

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "baseUrl": "https://api.deepseek.com/v1",
  "permission": "ask",
  "sandbox": "off",
  "contextBudget": 128000
}
```

| Field | Meaning |
| --- | --- |
| `provider` | Built-in key (`deepseek`, `openai`, `qwen`, `glm`, `moonshot`, `vllm`, `ollama`, `oneapi`, `custom`) or the name of a custom provider module in `~/.mingdao/providers/<name>.mjs` |
| `model` | Model name. Built-in presets live in `src/models.js`; a custom endpoint may use any name. `deepseek-v4-flash` is kept as an alias of `deepseek-flash` |
| `baseUrl` | OpenAI-compatible API base URL; overrides the provider's built-in default |
| `apiKey` | **Legacy, read-only fallback.** Do not put keys here |
| `temperature` | Sampling temperature; default `0.6` (or the model preset's value) |
| `maxOutputTokens` | Output cap per request. Clamped at runtime to `min(configured, model ceiling, contextWindow − budget)`; at least 1024 |
| `includeUsage` | Send `stream_options.include_usage` on streaming requests. Default `true`; set `false` for gateways that reject the field |

Built-in provider env-var hints (`src/models.js`): `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
`DASHSCOPE_API_KEY` (qwen), `ZHIPUAI_API_KEY` (glm), `MOONSHOT_API_KEY`, `VLLM_API_KEY`,
`OLLAMA_API_KEY`, `ONEAPI_API_KEY`, `MINGDAO_API_KEY` (custom). `MINGDAO_API_KEY` is also accepted as a
universal fallback.

### Custom models (`customModels`)

Written by the WebUI "add model" flow:

```json
{
  "customModels": {
    "my-gpt4":   { "label": "My GPT-4 gateway", "baseUrl": "https://gateway.example.com/v1" },
    "my-ds":     { "label": "Self-hosted DeepSeek", "baseUrl": "https://gw.example.com/v1", "tokenizer": "deepseek" },
    "local-qwen":{ "label": "Local Qwen", "baseUrl": "http://127.0.0.1:8081/v1", "contextWindow": 131072, "maxOutputTokens": 8192 }
  }
}
```

Recognised per-model keys: `label`, `baseUrl`, `tokenizer`, `contextWindow`, `maxOutputTokens`,
`maxOutputCeiling`, `local` / `isLocal`, plus the vision capability overrides consumed by
`resolveVisionSupport`. The key for a custom model is stored in the credential store under
`custom:<model-name>`.

* `tokenizer: "deepseek"` — for a non-DeepSeek-named endpoint that actually serves DeepSeek models.
  Without it the heuristic estimator is used (error up to ±2×).
* `contextWindow` — declares the model's real window. Unknown windows fall back to **32768** for local
  models and **128000** for remote ones (`src/model-caps.js`).

### Reasoning effort

* `reasoningByModel` — per-model override, e.g. `{ "deepseek-v4-pro": "low" }`. Values: `off` / `low` /
  `high` / `max`. `off` explicitly disables thinking.
* `reasoningEffort` — older global setting. Still honoured, but `reasoningByModel[<model>]` wins
  (`src/agent.js:116`).

### Model routing (optional, cost saver)

```json
{ "routing": { "enabled": true, "planner": "deepseek-v4-pro", "executor": "deepseek-flash",
               "upgradeSteps": 10, "upgradeTruncated": 2 } }
```

`enabled: false` (or an absent object) disables routing. `upgradeSteps` (default 10) and
`upgradeTruncated` (default 2) control when a sticky "flash" session is upgraded to the planner model.

### Pricing (`pricing`)

Built-in price data is dated **2026-08** (surfaced as `pricingAsOf` in `/api/state`).

```json
{
  "pricing": {
    "timezone": "Asia/Shanghai",
    "ttlDays": 7,
    "source": "https://…/pricing.json",
    "peakWindows": [[9, 12], [14, 18]],
    "overrides": {
      "deepseek-flash": { "input": 1.5, "output": 4.5, "cacheHit": 0.05, "peak": { "input": 3 } }
    }
  }
}
```

* Units are **CNY per million tokens**. Missing `peak.*` fields fall back to the off-peak price.
* Peak/off-peak is evaluated in `pricing.timezone` (default `Asia/Shanghai`), not the machine's local
  time zone. `peakWindows` is a list of `[startHour, endHour]` local-time windows (default
  `[[9,12],[14,18]]`); weekends are off-peak.
* `source` is an external official price JSON, refreshed by `mingdao update --pricing` and cached for
  `ttlDays` (default 7).

### Batch API

`mingdao batch <file|->` runs one question per line through the batch channel (50 % price, no tools, no
streaming).

* `batchBaseUrl` — gateway that supports the Batch API (default: the current provider base URL with a
  trailing `/v1` removed).
* `batchEndpoint` / `batchWindow` — protocol field overrides.

---

## Permissions (modes, rules, `denyStrict`)

`config.permission` is either a mode string or an object (`src/permissions.js:normalizePermission`):

```json
{ "permission": { "mode": "ask", "allow": ["bash", "bash:git *"], "deny": ["write"], "denyStrict": false } }
```

| Mode | Behaviour |
| --- | --- |
| `ask` (default) | Read-only tools are auto-allowed; writes and command execution ask every time |
| `auto` | Everything is allowed automatically |
| `readonly` | Only read-only tools are allowed; a write asks for a one-off override |

Anything that is not one of those three strings falls back to `ask`. The read-only tool set is
`READONLY_TOOLS` from `src/tools/index.js`.

### Rule syntax

* A rule is either a bare tool name (`"bash"`, `"write"`) or `"<tool>:<argument matcher>"`.
* `"bash:git *"` — trailing `*` is a prefix match, otherwise the whole argument string must match.
* **`allow` rules for `bash` are deliberately strict**: the command must consist only of
  `[A-Za-z0-9_ ./\\:-]`. Any shell metacharacter (`&&`, `||`, `;`, `|`, `&`, `<`, `>`, backtick, `$(`,
  `)`, newline, `\r`) makes the rule *not* match, so `git status && rm -rf /` cannot be escalated with
  a prefix rule. It falls back to the normal permission prompt.
* **`deny` rules for `bash` match the raw command text and are evaluated segment by segment.** The
  command is split on `;`, `&&`, `||`, `|`, `&`, newlines, `\r`, line-continuation backslashes, command
  substitution `$(`, backticks and parentheses, and a rule matches if **any** segment matches. This is
  why `deny: ["bash:rm *"]` also catches `cd /tmp && rm -rf /x`, `echo $(rm -rf /x)` and
  `` `rm -rf /x` ``. Quoted separators are split too, so expect the occasional extra prompt — the
  direction is fail-closed.
* Evaluation order: **`deny` → `allow` → `mode`** (`src/permissions.js:evaluatePermission`). A tool that
  matches neither falls back to the mode.
* `evaluatePermission()` is a pure function with no side effects; `check()` only adds the interactive
  prompt. Ledger replay uses the same function, so offline replay and live behaviour cannot drift.

### `denyStrict` (default `false`)

By default a `deny` hit is **not** a hard block: you get a prompt naming the exact rule that matched
("force this one through?"). `denyStrict: true` upgrades `deny` into a hard block with no override
prompt at all; the tool output states which rule was hit.

```json
{ "permission": { "mode": "auto", "deny": ["bash:rm *", "fetch:*"], "denyStrict": true } }
```

Additional `denyStrict` semantics (`src/permissions.js:130-147`):

* The hard block only applies when **at least one `deny` rule exists** (`deny.length > 0`). With an
  empty `deny` list, `denyStrict` alone changes nothing.
* Wrapper execution is rejected outright: when `denyStrict` is on and the command contains
  `sh|bash|zsh|dash|ksh|cmd|powershell|pwsh -c`, `eval`, or `command -v`, the call is denied with
  reason `deny-strict-wrapper` — deny rules cannot see through the argument string, so the wrapper form
  is refused rather than allowed to bypass them. (This is why `sh -c '…'` is rejected under
  `denyStrict` even when the inner command matches no rule.)
* Read-only mode overrides still prompt; `denyStrict` only affects `deny` hits.

Unattended / compliance-sensitive deployments (scheduled jobs, CI gates, containers) are the intended
audience. Interactive daily use should keep the default.

### Permission priority and presets (v0.6.14; narrowed in v0.6.16)

Priority of the *intent*: **explicit choice > preset suggestion (`recommendedPermission`) > `config.json`**.
Only two things actually change the mode: your explicit choice, and a `permission` field declared by a
legacy/third-party preset (subject to the anti-escalation rule — it may only be *more* conservative).

* **Built-in presets never carry any permission field.** `permission` is an *override* and would silently
  beat the mode you picked in the UI; `recommendedPermission` is merely a suggestion but is still a
  permission-preference hint, so built-in presets do not use it either. The field itself is retained so
  third-party/self-written presets can still declare it (suggestion only: never judged, never changes the mode).
* **Want read-only? Combine a permission mode with a tool allow-list yourself.** A preset's `tools`
  allow-list is the hard constraint (no `write`/`edit` means the model never even sees the write tools);
  pinning the session to the `readonly` mode is the second layer. Built-in presets decide neither for you.
* **Built-in presets only ship parameter defaults.** The distribution targets the general public and does
  not customize for any particular task, so the only built-in preset is `local-model` — it only tunes
  `contextBudget` / `maxOutputTokens` / `maxRounds` and carries **no persona, no tool allow-list and no
  permission fields**. The former built-in read-only code-audit preset `readonly-audit` was **removed** in
  v0.6.16; the old name `local-audit` still works but prints a "renamed to `local-model`" notice.
* The tool-call audit log / ledger has nothing to do with presets: that is `config.audit` plus
  `mingdao audit` / `mingdao ledger`. Do not treat any preset as a compliance audit switch.

### File access boundary

`read` / `write` / `edit` / `ls` / `glob` / `grep` / `undo` are confined to the working directory.
`realpath`-based checks prevent symlink escapes; dangling symlinks are resolved recursively and
rejected when they point outside (`src/tools/fs-tools.js`). To grant access outside the working
directory:

```json
{ "fsAllowDirs": ["/home/you/projects/shared", "/tmp/build-output"] }
```

Whitelisted directories are still `realpath`-checked (a symlink inside them pointing outside is
refused).

### Hooks (`hooks`) — configuration is code execution

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "write|edit|bash", "cmd": "node ~/hooks/pre.js" }],
    "PostToolUse": [{ "matcher": "*", "cmd": "curl -X POST http://localhost:9000/audit" }]
  }
}
```

* `matcher` accepts an exact tool name, a `,`- or `|`-separated list, and a trailing `*` wildcard.
* The hook process receives JSON on **stdin**:
  `{hook_event_name, tool_name, tool_input}` (plus `tool_response` for `PostToolUse`).
* **`PreToolUse` decision semantics (verified in `src/hooks.js:175-205`)** — this is where the Chinese
  doc is imprecise:
  * empty stdout → **allow**;
  * stdout that parses as JSON with `{"decision":"block","reason":"…"}` → **block**;
  * stdout that is non-empty but **not** valid JSON (or exceeds the 64 KB capture limit) →
    **block, fail-closed**, with a message that distinguishes truncation from a genuine parse failure;
  * valid JSON *without* `decision: "block"` (e.g. `{"decision":"approve"}`, or any other object) →
    **allow**.
  The Chinese doc's "non-empty output blocks execution" is therefore an overstatement: only a JSON
  `block` decision (or unparsable output) blocks.
* **Hook commands run with `shell: true`.** Only put commands you fully trust here.
* Hook child processes get the **same sensitive-env filtering** as the `bash` tool (see below).

### MCP servers (`mcpServers`)

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/your/dir"], "trusted": true }
  }
}
```

Same shape as Claude Code. Tools are merged into the agent loop as `mcp__<server>__<tool>`.

* **A `readOnlyHint` is only trusted for servers marked `"trusted": true`** (`src/mcp.js`). Untrusted
  servers — including tools annotated read-only — always go through the permission prompt, because a
  server can lie about being read-only.
* MCP child processes inherit the filtered environment (same `bashEnvKeep` / `bashEnvFilter` rules).

### Declarative tools (`tools`)

```json
{ "tools": [{ "name": "deploy", "description": "…", "parameters": { }, "command": "./deploy.sh", "timeout": 120 }] }
```

Each entry is a shell command parsed by the command itself (no argument interpolation, to avoid
injection). Execution is gated by the same permission engine as `bash`, the subprocess gets the
filtered environment, and arguments are passed via `MINGDAO_TOOL_ARGS` as JSON. Entries are mounted at
process start; changing `config.tools` requires a restart.

---

## Sandbox & bash env filtering

### Sandbox tiers (`sandbox`)

| Value | Behaviour |
| --- | --- |
| `off` (default) | Execute directly, no isolation |
| `readonly` | Whole filesystem read-only, `/tmp` writable (tmpfs), network available |
| `safe` | Read-only root, working directory and `/tmp` writable, **network disabled** (`--unshare-net`) |

* Only **Linux + bubblewrap** can sandbox. Capability is probed for real (a minimal
  `bwrap --ro-bind / / --tmpfs /tmp true` must exit 0) — a container where `--version` succeeds but the
  real sandbox fails degrades to `off` too.
* On any other platform, or without a working `bwrap`, the run **degrades to `off` and says so** in the
  tool result (`note: "sandbox mode \"…\" unavailable …"`). It never pretends to have sandboxed.
* `sandbox` is read from **config first**: `String(ctx.cfg.sandbox ?? args.sandbox ?? 'off')`. The model
  cannot downgrade a configured `safe`/`readonly` sandbox by passing `sandbox: "off"` in the tool call.

### Sensitive environment-variable filtering

The `bash` tool strips sensitive variables from the child environment **by default**, independently of
the sandbox tier (`sandbox: "off"` still filters). A single `env` command therefore cannot dump API
keys into the model context.

A variable is dropped when either:

* it matches `/(api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)/i`, or
* it contains a `_`-delimited segment from the shared secret-word list
  (`src/redact.js:ENV_SECRET_SEGMENTS`, shared with the redactor):
  `key`, `keys`, `apikey`, `token`, `secret`, `password`, `passwd`, `pass`, `credential`,
  `credentials`, `auth`, `authorization`, `cookie`, `session`.
  `pwd` is deliberately excluded from the env list (`PWD` is a normal shell variable).

**Exception:** `SSH_AUTH_SOCK` is always kept (`ENV_ALWAYS_KEEP`). Without it, git-over-SSH and
ssh-agent would break — it is a connection handle, not a credential.

```json
{ "bashEnvKeep": ["NPM_TOKEN"], "bashEnvFilter": false }
```

* `bashEnvKeep` — keep these variable names even if they look sensitive. Only meaningful while filtering
  is on.
* `bashEnvFilter: false` — disable filtering entirely and pass the full environment through.

The same filtering applies to **hooks**, **MCP servers** and **`config.tools`** subprocesses
(`buildChildEnv`, `src/tools/bash.js:33`).

### bash execution limits

| Setting | Default | Notes |
| --- | --- | --- |
| `timeout` (tool argument) | 120 s | Hard cap 600 s (`MAX_TIMEOUT_SECONDS`) |
| stdout/stderr capture | last 20 000 chars each | Measured in bytes internally (`MAX_OUTPUT * 2`), decoded once at the end, ANSI-stripped and repeat-folded before truncation |

A timeout kills the whole process group (`SIGKILL` on `-pid`), and a further 3 s watchdog cleans up
children that hold the pipe open.

---

## Network egress gate (and what it does NOT cover)

`config.net` turns "no data leaves this machine" from a verbal promise into an exportable record.

```json
{
  "net": {
    "allow": ["api.deepseek.com", "*.internal.corp", "10.0.0.0/8", "192.168.1.50"],
    "mode": "warn",
    "allowLoopback": true
  }
}
```

| Field | Meaning |
| --- | --- |
| `allow` | Allowed destinations. Four forms: exact host (`api.deepseek.com`), wildcard subdomain (`*.example.com` — **does not include the bare domain**), IPv4 CIDR (`10.0.0.0/8`), exact IPv4. Matching is case-insensitive |
| `mode` | `warn` (default): out-of-list requests are **allowed but logged**; `block`: out-of-list requests are refused with guidance |
| `allowLoopback` | Default `true`. Loopback (`localhost`, `127.0.0.0/8`, `::1`, `[::ffff:127.x]`) is exempt — it cannot leave the machine, and local models (Ollama/vLLM) are the main use case. **Private networks are not loopback**; add them to `allow` explicitly |

That is the whole object: `parseNetPolicy` reads exactly `allow`, `mode` and `allowLoopback` — there is no
`net.timeout` or similar. CIDR and wildcard rules are IPv4/domain only; an IPv6 host can only match a rule
by exact string (`::ffff:127.0.0.1` normalizes to its hex form inside URLs).

**With no `config.net` the gate is not installed at all** (`installEgressGate` returns `false`), so
existing behaviour is untouched.

### Where the gate is enforced

`globalThis.fetch` is wrapped once, so every HTTP exit that goes through it is judged:
model API calls, the `fetch` tool, the skill registry, model discovery, pricing data, Batch. Paths that
must use `node:http(s).request` call the same entry point explicitly:

* `src/safe-fetch.js` (skill downloads / registry / model discovery) calls `guardEgress()` per hop;
* `src/sync.js` (the self-signed-certificate `node:https` path) calls `decideEgress()`;
* `src/update.js` resolves the git remote URLs (including the `git@host:path` scp form) and judges them
  before updating — under `block`, the update is refused unless **at least one** mirror is allowed.

Redirects are followed by the gate itself and judged **per hop** (max 20 hops). A cross-origin hop drops
all headers except a small reverse allow-list (`accept`, `content-type`, `range`, `user-agent`,
conditional headers, …), so `Authorization`, `x-api-key`, `cookie` and any custom credential header do
not travel to the redirect target.

The egress decision is written to `~/.mingdao/net.jsonl` (mode `600`), which records **only** timestamp,
host, port, kind, allow/deny, matched rule and mode — never the request body and never the full URL.
Rotation is size-based: above **2 MiB** the file is rewritten to its last 10 000 lines (atomic write);
loopback and "gate not installed" decisions are not written at all. When the gate is active, each turn's
execution ledger also gets a `net.egress` event.

Inspection commands:

```bash
mingdao net policy                      # current policy and whether it is active
mingdao net report                      # which external hosts were contacted (count / allowed / blocked / rule)
mingdao net report --since 7d --json    # 7d / 24h / 90m accepted
```

### ⚠ What the gate does **not** cover — read this before quoting it

Covered: kernel-initiated requests that go through `globalThis.fetch` **or** one of the explicitly wired
paths listed above (model API, `fetch` tool, skill registry, model discovery, pricing data, Batch, cloud
sync including the self-signed `node:https` path, and self-update git remotes).

**Not covered — these are other processes the kernel merely starts; their sockets are invisible to the
gate:**

* **MCP servers.** The kernel spawns them; every network request they make is their own process's.
* **`config.tools` and Pack tools that spawn their own subprocesses.** Same reason.
* **Commands you type yourself in `bash`** (`curl`, `git`, `pip`, …).
* **The Electron desktop shell's own update check.** That is Electron's network stack.

So what it proves is: *"every target the kernel contacted through its HTTP exits and its self-update path
was on the allow-list."* It does **not** prove *"this machine sent nothing out."* Treating it as the
latter is misuse. If you need process-level enforcement, do it at the OS/gateway layer (egress proxy,
firewall, EDR) — this gate is a kernel self-attestation tool, not a sandbox.

---

## Cost guard

```json
{ "costGuard": { "dailyLimitYuan": 10, "warnAtYuan": 8, "action": "block", "downgradeModel": "deepseek-flash" } }
```

Costs are accumulated per **Beijing calendar day** from `cache-stats.jsonl` (real post-discount figures,
including cache discounts and the Batch 50 % price). The guard is checked at the start of every agent
round.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dailyLimitYuan` | number | none (guard inactive without it) | Daily limit in CNY |
| `warnAtYuan` | number | `dailyLimitYuan × 0.8` | Warning threshold |
| `action` | string | `"warn"` | `warn` = notify only; `block` = pause execution at the limit (recovers automatically the next day); `downgrade` = switch to `downgradeModel` and keep going |
| `downgradeModel` | string | `DEFAULT_MODEL` (`deepseek-flash`) | Downgrade target. Any value other than `block`/`downgrade` for `action` is treated as `warn` |

Additional verified semantics:

* **Downgrade already at the cheapest model blocks.** If the active model *is* `downgradeModel` (or the
  round already downgraded once), the guard reports `already-cheapest` and the round is stopped rather
  than silently continuing to spend (`roundGuardAction`). The Chinese doc's "already flash → treat as
  block" matches this.
* **In-flight downgrade.** Under `action: "downgrade"`, the guard also triggers when *today's spend
  including this round's in-flight cost* reaches the limit, so a single expensive round cannot overshoot
  the daily cap while waiting for the ledger to settle.
* **Pre-flight interception.** Before an expensive request is sent, `preflightBlockMessage()` compares
  `used + worst-case round cost` against the limit and refuses to send the request when it would exceed
  it.
* **Unknown usage is never silently counted as 0:**
  * If `cache-stats.jsonl` cannot be **read** (as opposed to not existing yet), `todayCost()` returns
    `null`. The guard then reports `degraded` and **does not block** — it warns once
    ("cannot judge right now") instead of pretending today's spend is ¥0. A missing file is a genuine
    ¥0 (fresh install).
  * If a call reports no `usage` from the server (`usageUnknown: true`), the amount cannot be computed;
    the entry count is surfaced as "N calls today had unknown usage — the guard may under-count this
    spend" (once per process, and only *after* all hard block/downgrade/warn decisions so it cannot
    displace a real limit hit).
  * If the active model has no price data, `noPricing` is set and the guard warns explicitly that
    `dailyLimitYuan` cannot be accumulated — again, not a silent pass.

`/cost` and the WebUI header cost badge show "today's spend / limit percentage" live.

---

## WebUI & sync server exposure

```json
{ "web": { "host": "127.0.0.1", "port": 3820, "token": "optional access token" } }
```

| Field | Default | Notes |
| --- | --- | --- |
| `web.host` | `127.0.0.1` | Bind address. `mingdao web` reads it from config; the function signature default is the same |
| `web.port` | `3820` | A positional port argument overrides it |
| `web.token` | none | Access token. Never required on loopback |
| `web.autoStart` | unset | Whether `mingdao` starts the WebUI in the background |
| `web.browseRoots` | `[]` | Extra directories allowed as workspaces / browsable |
| `web.allowAnyWorkspaceDir` | `false` | Lift the directory fence entirely (**only on a fully trusted machine**) |
| `web.allowPrivateEndpoints` | `false` | Allow private-network model endpoints while listening on a non-loopback address |

### Authentication

* On loopback with no token configured, the server runs in **local-trust mode**: no token check. Any
  other process — or other user — on the same machine can reach `/api/*`. Enable a token on
  multi-user machines and shared CI.
* **Binding `0.0.0.0` or a LAN address forces token auth.** If no token is configured, one is generated
  per start (`crypto.randomBytes(16).toString('hex')`, 32 hex chars) and printed as
  `http://<address>:<port>/?token=…`.
* Fixed-token precedence, **as implemented** (`src/commands/skill.js:178-183`):

  ```
  mingdao web --auth-token <token>   >   $MINGDAO_WEB_TOKEN   >   config.json web.token
  ```

  > ⚠ The Chinese `docs/CONFIG.md` lists these in the opposite order (env var first, CLI flag last).
  > The code comment and the code itself put the CLI flag highest. The code wins.
* A literal `--auth-token <token>` lands in `argv` and shell history (`ps` can see it), so the CLI warns;
  `--auth-token=-` reads the token from stdin instead.
* The token is accepted as `?token=`, the `X-MingDao-Token` header, or `Authorization: Bearer …`, and is
  compared with `crypto.timingSafeEqual`.
* The token check covers data and action endpoints. The **static shell is deliberately public** even when
  a token is enabled (`/`, `/index.html`, `/app.js`, `/util.js`, `/constants.js`, `/favicon.ico`,
  `/icon.svg`, `/icon-192.png`, `/icon-512.png`, `/manifest.webmanifest`, `/sw.js`) — the SPA has to load
  before it can read `?token=` out of the URL. The shell carries no data. The `Host` check still applies
  to every request.

### Host allow-list (DNS-rebinding protection)

The `Host` header must equal a loopback name (`127.0.0.1`, `localhost`, `::1`) or the configured bind
address, with the bound port (or no port when the port is 80). Proxied setups returning 403 are expected.

**Exception — `host: "0.0.0.0"` with a token enabled validates no Host at all**
(`return host === '0.0.0.0' && authEnabled;`). In that mode **the token is the access boundary** — an
attacker's page cannot obtain it. This is the mode designed for LAN / phone access, so a token is
mandatory there; when none is configured the server generates a random one automatically (see above).
This exception is the fix for audit finding F-M2.

### Cross-site and origin checks

* Browser requests with `Sec-Fetch-Site: cross-site` (including `<img>` and `no-cors` blind requests) or
  `same-site` are rejected with **403**, except GET/HEAD navigations for the static shell
  (`/`, `/index.html`, `/app.js`, `/favicon.ico`, `/icon.svg`, `/manifest.webmanifest`, `/sw.js`).
  `Sec-Fetch-Site` is a browser-forced metadata header that page scripts cannot forge. Older browsers
  that do not send it fall back to the pre-existing policy.
* Any request carrying an `Origin` header whose host differs from the request `Host` is rejected with
  403, for **all** methods. Non-GET/HEAD/OPTIONS requests additionally require a JSON `Content-Type`.
* A missing/invalid token (when auth is on) returns **401**; a failing `Host` check returns 403.

### Cloud metadata endpoints

Cloud metadata addresses (`169.254.169.254`, `169.254.0.23`, `169.254.170.2`, `100.100.100.200`,
`fd00:ec2::254`, `metadata.google.internal`, `metadata.goog`) are **rejected unconditionally** — under
any bind address and any flag. `web.allowPrivateEndpoints` and loopback binding do not exempt them
(`src/web/server.js:322`, `src/ssrf-guard.js:97-102`). When the server listens on a non-loopback
address, all private/loopback model endpoints are rejected as well (DNS results are checked address by
address, and DNS failure is fail-closed).

### Workspace / directory fence

Registering or browsing a directory is limited to the home directory, the startup directory, the current
workspace, plus explicit `web.browseRoots` (on Windows: Desktop, Documents, Downloads). The check uses
`realpath`, so symlinks cannot escape; dangling symlinks are resolved recursively and refused outside the
fence; symlink loops fail in bounded time. Returned paths are the normalized real paths (on macOS
`/var/folders/…` is shown as `/private/var/folders/…`).

### Cloud sync (`sync`)

```json
{
  "sync": { "url": "https://session.mingdao.ai", "username": "you", "deviceName": "my laptop",
            "auto": true, "insecure": false }
}
```

The device token lives in the credential store (`credentials.json`, `sync` field) — config only holds
non-secret fields. `auto` defaults to `true` (`s?.auto !== false`). `insecure: true` disables TLS
verification for sync requests only (self-signed certificates during migration) and should be removed
once a real certificate is in place.

The **sync server** (`mingdao sync-server`) is configured by environment variables, not by this file:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYNC_HOST` / `SYNC_PORT` | `0.0.0.0` / `443` | Listen address |
| `SYNC_DATA_DIR` | `/var/lib/mingdao-sync` | Data directory |
| `SYNC_CERT` / `SYNC_KEY` | none | Both must be set together; setting only one refuses to start instead of silently serving plaintext |
| `SYNC_ALLOW_INSECURE`, `SYNC_TRUST_PROXY` | off | Only for trusted reverse-proxy deployments |
| `MINGDAO_SYNC_REGISTRATION` | `open` | `open` / `invite` / `closed` |
| `MINGDAO_SYNC_INVITE_CODES` | none | Comma-separated codes, used when registration is `invite`. At least `invite` is recommended for public deployments |

---

## Audit log & ledger

### Tool-call audit (`audit.jsonl`)

Every tool call — including denied calls, hook-blocked calls and argument-parse failures — appends one
JSON line to `~/.mingdao/audit.jsonl` (mode `600`): timestamp, session, model, tool name, arguments
(`sk-`-style keys and other secrets redacted), result / exit code / timeout / duration / output size, and
the rejection reason.

* **Rotation is size-based, not line-based.** The trigger is `statSync(file).size > 4 * 1024 * 1024`
  (4 MiB, "≈ 20 000 lines at ~200 bytes/line"), after which the file is rewritten to its last
  **10 000** lines. The line count is only a secondary condition (`lines.length > KEEP_LINES`). The code
  comment explains why: the previous in-process counter never reached its threshold in CLI sessions, so
  line-based rotation was dead code and `audit.jsonl` grew without bound.
* Append and rotation happen **inside the same file lock**, so a concurrent append cannot be lost during
  a rewrite; the rewrite itself is atomic (tmp + rename), so a crash cannot leave a half file.
* If writing fails, the session is not interrupted, but it is **not silent** either: a failure counter
  and the reason are kept and a one-time warning is printed. Audit failures do not affect the ledger.
* View with `mingdao audit [count]` (default 20, capped at 500) or `/audit` inside a session.
  `"audit": false` disables the audit log (default: on).

### Execution ledger (`ledger/`)

Each turn writes a ledger under `~/.mingdao/ledger/<runId>.jsonl` plus a `<runId>.seal.json`, recording
run start, tool calls, permission decisions, constraint events, net egress events and usage. Ledgers are
redacted, individual string fields are capped at 2000 characters, at most the **200** most recent runs
are kept, and the directory runs it in mode `700`. `"ledger": false` disables it. The ledger exists
because `audit.jsonl` rotation would silently truncate a compliance record — a truncated ledger is worse
than none.

### Session journal

At the end of each session a one-line entry (first user message + result summary) is appended to
`~/.mingdao/journal.jsonl`. It is **not** injected into new sessions by default; opt in per run with the
WebUI "📌 carry context" checkbox or `mingdao --journal`.

---

## Context, tokenizer & compaction

### Budget

`contextBudget` is the *requested* prompt budget. The effective budget is always recomputed
(`src/model-caps.js:safeBudget`):

```
budget = max(1024, min(contextBudget ?? preset budget ?? comfort,
                       contextWindow − maxOutputTokens − headroom,
                       floor(contextWindow × 0.75)))
```

`COMFORT_RATIO` is 0.75 and the effective output cap is at least 1024 tokens.

* Unknown context windows fall back to **32 768** for local models and **128 000** for remote ones.
* Local models (loopback / private-IP `baseUrl`, or `customModels.<name>.local: true`) are treated as
  resource-constrained.
* A single tool result is capped at `min(20000, max(2000, floor(contextWindow / 16)))` characters, so a
  small-window model is not flooded with one huge file dump.
* Edge detection: when the model reports real `prompt_tokens ≥ 85 %` of the window (`EDGE_RATIO`),
  compaction is forced on the next round even if the heuristic counter underestimates.

### Tokenizer

An exact DeepSeek BPE tokenizer ships with the package (official vocabulary,
`assets/tokenizer-data.json.gz`), with content-level caching. Non-DeepSeek models fall back to a
heuristic: English ≈ 4 characters/token, CJK ≈ 0.75 tokens/character, other non-ASCII ≈ 1. For a custom
endpoint serving DeepSeek models, set `"tokenizer": "deepseek"` on the model entry to get exact counting.
The tokenizer is only used for budget accounting; it never emits token ids.

### Auto-compaction

Long sessions that would silently drop early messages get those messages summarized by the executor model
(or the active model when routing is off) into a single user message.

* `autoCompact` (default `true`; `false` returns to plain silent trimming).
* `compactTrigger` — trigger ratio, default **0.8** (local models **0.6**). Values are clamped into
  `[TARGET_RATIO = 0.6, 1]`; anything above 1 is clamped to 1 **with a warning**, because a value > 1
  would make automatic compaction never trigger while the session grows to the window limit.
* Compaction keeps the tail at ≈ 60 % of budget (hysteresis), requires at least **3** dropped messages
  and **2000** dropped tokens, and caps the summary at 500 characters in the prompt (hard truncation at
  1600 characters). The summary request uses `response_format: json_object` with a plain-text fallback.
* After compaction the session file is rewritten in compacted form, and already-compacted sessions only
  summarize the new segment (summary of summaries).
* Any summarization failure falls back to ordinary trimming — compaction never blocks a session.

### Timeouts (`timeout`)

| Field | Local model default | Remote default |
| --- | --- | --- |
| `firstTokenMs` | 600 000 ms | 300 000 ms |
| `streamIdleMs` | 120 000 ms | 120 000 ms |
| `totalMs` | 1 800 000 ms | 600 000 ms |

```json
{ "timeout": { "firstTokenMs": 600000, "streamIdleMs": 120000, "totalMs": 1800000 } }
```

The local-endpoint pre-flight also reads the **engine's own context size** (`GET /props`, e.g. llama.cpp's
`default_generation_settings.n_ctx`) and prints it next to the configured `contextWindow`; when the
configuration exceeds the engine, the kernel warns that long contexts will be rejected by the engine
outright (switching presets or lowering `contextBudget` cannot change the engine's `n_ctx`). If the field
cannot be read, the pre-flight says so instead of guessing.

Other guard fields: `maxEmptyRounds` (max consecutive empty/truncated output rounds before stopping,
default **3** — each empty round is billed as a full completion), `maxRounds` (auto-continuation rounds
after the step limit, default **3**), `maxAgentsMdChars` (cap on injected `AGENTS.md` content, default
**4000**; `0` disables injection; the full file stays readable on demand), `schemaTier` (`false` disables
the tiered tool-schema injection).

### Project memory

At session end, a few durable conclusions are extracted into the **current project** directory:

```
<your project>/.mingdao/memory.md      # e.g. "- [2026-09-11] decision: split config into multiple files"
```

* Toggle: `autoProjectMemory` (default `true`). Global memory lives at `~/.mingdao/memory.md`.
* Creating `.mingdao/` also writes `.gitignore` containing `*`, so notes about you and your work are not
  swept into a `git add -A`. An existing `.gitignore` is never overwritten — delete it if you want to
  share project memory with your team.
* Memory is isolated per workspace and is never injected across projects.

---

## Constraints & Packs

### Constraints (enforced by the kernel)

`config.constraints` (or a Pack's `constraints` contribution) declares domain red lines. Unlike Pack
`permissions` below, these **are** evaluated by the kernel, at three stages
(`src/constraints.js`, wired in `src/agent.js`):

| Stage | Kinds |
| --- | --- |
| Pre-tool | `tool-deny`, `tool-arg-require`, `arg-forbid`, `confirm` |
| Post-tool (result rejected, re-collection requested) | `completeness`, `result-forbid` |
| Pre-output | `output-forbid` (`action`: `block` / `block-and-rewrite` / `warn`) |

* Constraints can only **tighten** — they never grant permissions and never change the permission
  engine's decision.
* Evaluation is **fail-closed**: an invalid/missing regex pattern or an evaluation error blocks (scoped
  to the tool where possible) rather than passing silently.
* `confirm` forces a human confirmation even in `auto` permission mode.
* Every constraint event is written to the audit log and the turn ledger (`pack`, `constraint`, `kind`,
  `stage`, `action`).
* With no constraints configured, all checkpoints are completely inert (zero overhead).

### Pack `permissions` are a declaration — not enforced

A Pack manifest may declare:

```json
{ "permissions": { "fs": ["…"], "net": ["…"], "env": ["…"] } }
```

`packs.js` validates the shape (`fs` / `net` / `env`, each a string array) but **the kernel does not
enforce any of it**. `pack.mjs` is imported into the host process, so it can read and write any file and
make any network request. Because a security narrative that does not hold is worse than no narrative,
loading a Pack performs a **static comparison** between the capabilities the source actually uses
(`fetch(`, `fs.*`, `process.env`) and what the manifest declared, and warns loudly about undeclared
usage. The warning is not a block.

Consequence: **review third-party `pack.mjs` before installing it.**

### Pack discovery and trust

`config.packs` lists Pack directories explicitly (highest priority, later entries win). Both forms are
accepted: a path that *is* a Pack (contains `pack.json`), or a root directory containing several Packs.
Project-local Packs pass through a trust gate (content fingerprint recorded at install/verify time;
tampered Packs are refused and flagged).

---

## Environment variables

| Variable | Scope | Meaning |
| --- | --- | --- |
| `MINGDAO_HOME` | all commands | Overrides `~/.mingdao` for config, credentials, sessions, logs, ledger |
| `MINGDAO_API_KEY` | all providers | Universal API-key fallback; the provider-specific variable is checked first |
| `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `DASHSCOPE_API_KEY`, `ZHIPUAI_API_KEY`, `MOONSHOT_API_KEY`, `VLLM_API_KEY`, `OLLAMA_API_KEY`, `ONEAPI_API_KEY` | provider-specific | Key resolution (highest priority) |
| `MINGDAO_WEB_TOKEN` | `mingdao web` | WebUI access token (below `--auth-token`, above `web.token`) |
| `MINGDAO_NO_WEB_AUTOSTART` | REPL | Do not auto-start the WebUI even if `web.autoStart` is true |
| `MINGDAO_ASK_TIMEOUT_MS` | WebUI | Permission-prompt wait limit (default 120 000 ms) |
| `MINGDAO_DEBUG` | CLI | Print stack traces / extra warnings on failures |
| `MINGDAO_REGISTRY_URL` | skill registry | Point at a self-hosted `index.json` (HTTPS, or HTTP only on loopback) |
| `MINGDAO_NO_DAEMON` | `mingdao schedule` | `1` disables the scheduler daemon and uses the per-task sleeper fallback |
| `MINGDAO_TASK_QUIET_NOTIFY` | background task workers | Suppress desktop notifications for that worker |
| `MINGDAO_LOCK_TIMEOUT_MS`, `MINGDAO_LOCK_STALE_MS` | file locking | Tune lock waits / staleness (diagnostics, tests) |
| `MINGDAO_BATCH_TIMEOUT_MS`, `MINGDAO_BATCH_POLL_MS`, `MINGDAO_BATCH_MAX_BYTES` | `mingdao batch` | Request timeout (120 s), poll base interval (5 s), result size cap (32 MiB) |
| `MINGDAO_TOKENIZER_RETRY_MS` | tokenizer | Retry interval after a failed vocabulary load |
| `MINGDAO_SYNC_REGISTRATION`, `MINGDAO_SYNC_INVITE_CODES` | `mingdao sync-server` | Registration mode (`open` / `invite` / `closed`) and invite codes |
| `SYNC_HOST`, `SYNC_PORT`, `SYNC_DATA_DIR`, `SYNC_CERT`, `SYNC_KEY`, `SYNC_ALLOW_INSECURE`, `SYNC_TRUST_PROXY` | `mingdao sync-server` | Server binding, TLS and proxy settings |
| `EDITOR` / `VISUAL` | REPL | Editor used by `/memory edit`. Colour is decided solely by `process.stdout.isTTY`, not by `NO_COLOR` / `FORCE_COLOR` |

---

## Full field reference table

Defaults are the values that apply when the field is absent. "—" means the field has no default and the
feature is inactive until configured.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | string | `"deepseek"` (written by first run) | Provider key or custom provider module name |
| `model` | string | `"deepseek-flash"` | Model name or alias |
| `baseUrl` | string | provider preset | OpenAI-compatible API base URL |
| `apiKey` | string | — | **Legacy fallback only**; keys belong in the credential store |
| `temperature` | number | `0.6` or preset | Sampling temperature |
| `maxOutputTokens` | number | model preset | Output cap, clamped to the window |
| `includeUsage` | boolean | `true` | Send `stream_options.include_usage` |
| `permission` | string \| object | `"ask"` | `ask` / `auto` / `readonly`, or `{mode, allow, deny, denyStrict}` |
| `permission.mode` | string | `"ask"` | Invalid values fall back to `ask` |
| `permission.allow` | string[] | `[]` | Tool or `tool:prefix` rules that auto-allow |
| `permission.deny` | string[] | `[]` | Rules that match first; prompts by default |
| `permission.denyStrict` | boolean | `false` | Turn `deny` into a hard, non-overridable block; also rejects `sh -c` / `eval` wrappers when `deny` is non-empty |
| `sandbox` | string | `"off"` | `off` / `readonly` / `safe`; Linux + bwrap only, otherwise degrades with a note |
| `bashEnvKeep` | string[] | `[]` | Environment variable names to keep despite looking sensitive |
| `bashEnvFilter` | boolean | `true` | `false` disables sensitive-variable filtering entirely |
| `fsAllowDirs` | string[] | `[]` | Extra absolute directories the file tools may touch |
| `contextBudget` | number | `128000` (first run) | Requested prompt budget in tokens; always re-clamped to the model window |
| `autoCompact` | boolean | `true` | Automatic conversation compaction |
| `compactTrigger` | number | `0.8` (local `0.6`) | Compaction trigger ratio, clamped to `[0.6, 1]` with a warning above 1 |
| `maxEmptyRounds` | number | `3` | Max consecutive empty/truncated output rounds |
| `maxRounds` | number | `3` | Auto-continuation rounds after the step limit |
| `maxAgentsMdChars` | number | `4000` | Cap on injected `AGENTS.md` characters; `0` disables injection |
| `schemaTier` | boolean | `true` | `false` disables tiered tool-schema injection |
| `timeout.firstTokenMs` | number | local `600000`, remote `300000` | First-token wait |
| `timeout.streamIdleMs` | number | `120000` | Stream idle timeout |
| `timeout.totalMs` | number | local `1800000`, remote `600000` | Total request timeout |
| `noProgressTimeoutMs` | number | `3600000` | Turn-level no-progress watchdog (2× the local single-request cap; `0`/negative/`Infinity` fall back to the default). A `task` sub-agent's real progress counts as the parent turn's progress, a stalled sub-agent is stopped by **its own** watchdog first so the reason travels back, and the ending is reported as `stalled` (distinct from `capped`/`aborted`) via a warning banner plus `done.note` |
| `audit` | boolean | `true` | Tool-call audit log |
| `ledger` | boolean | `true` | Per-turn execution ledger |
| `notify` | boolean | `true` | Desktop notifications when background tasks finish |
| `autoTitle` | boolean | `true` | Auto-generate session titles |
| `autoProjectMemory` | boolean | `true` | Extract project memory at session end |
| `autoMemory` | boolean | `true` | Extract global memory at session end (needs ≥ 3 turns) |
| `reasoningByModel` | object | — | Per-model reasoning effort: `off` / `low` / `high` / `max` |
| `reasoningEffort` | string | — | Legacy global reasoning effort; lower priority than `reasoningByModel` |
| `routing` | object | — | `{enabled, planner, executor, upgradeSteps: 10, upgradeTruncated: 2}` |
| `pricing.timezone` | string | `"Asia/Shanghai"` | Time zone used for peak/off-peak pricing |
| `pricing.peakWindows` | number[][] | `[[9,12],[14,18]]` | Peak windows as whole hours in `pricing.timezone` |
| `pricing.source` | string | — | External official price JSON URL |
| `pricing.ttlDays` | number | `7` | Cache TTL for `pricing.source` |
| `pricing.overrides` | object | — | Per-model price override in CNY per million tokens (`input`, `output`, `cacheHit`, `peak.*`) |
| `costGuard.dailyLimitYuan` | number | — | Daily spend limit in CNY (Beijing calendar day) |
| `costGuard.warnAtYuan` | number | `limit × 0.8` | Warning threshold |
| `costGuard.action` | string | `"warn"` | `warn` / `block` / `downgrade` |
| `costGuard.downgradeModel` | string | `"deepseek-flash"` | Downgrade target; already on it → block |
| `net.allow` | string[] | `[]` | Exact host / `*.sub.domain` / IPv4 CIDR / exact IPv4 |
| `net.mode` | string | `"warn"` | `warn` (log and allow) or `block` (refuse) |
| `net.allowLoopback` | boolean | `true` | Exempt loopback from the allow-list |
| `web.host` | string | `"127.0.0.1"` | Bind address |
| `web.port` | number | `3820` | Listen port |
| `web.token` | string | — | Access token; forced (randomly generated) on non-loopback binds |
| `web.autoStart` | boolean | — | Start the WebUI in the background with `mingdao` |
| `web.browseRoots` | string[] | `[]` | Extra allowed workspace/browse directories |
| `web.allowAnyWorkspaceDir` | boolean | `false` | Disable the workspace directory fence |
| `web.allowPrivateEndpoints` | boolean | `false` | Allow private-network model endpoints when listening publicly |
| `sync.url` | string | — | Sync server base URL |
| `sync.username` | string | — | Sync account name |
| `sync.deviceName` | string | host name | Device label (≤ 60 chars) |
| `sync.auto` | boolean | `true` | Automatic sync |
| `sync.insecure` | boolean | `false` | Skip TLS verification for sync requests (self-signed certs, temporary) |
| `customModels.<name>.label` | string | — | Display name |
| `customModels.<name>.baseUrl` | string | — | Endpoint for this model |
| `customModels.<name>.tokenizer` | string | — | `"deepseek"` for exact counting |
| `customModels.<name>.contextWindow` | number | local `32768` / remote `128000` | Real context window |
| `customModels.<name>.maxOutputTokens` | number | preset or `min(8192, window/8)` | Output cap |
| `customModels.<name>.maxOutputCeiling` | number | preset | Hard ceiling for an explicitly configured output size |
| `customModels.<name>.local` / `.isLocal` | boolean | inferred from `baseUrl` | Force local-model treatment (compaction, serialization, timeouts) |
| `mcpServers.<name>` | object | — | `{command, args, env, trusted}`; only `trusted: true` servers have their `readOnlyHint` believed |
| `hooks.PreToolUse` | array | — | `[{matcher, cmd}]`; empty output allows, JSON `{"decision":"block"}` blocks, unparsable output blocks fail-closed |
| `hooks.PostToolUse` | array | — | `[{matcher, cmd}]`; observation only, never blocks |
| `tools` | array | — | Declarative shell tools `{name, description, parameters, command, timeout}` |
| `packs` | string[] | `[]` | Explicit Pack directories (highest discovery priority) |
| `constraints` | array | — | Domain constraints; **enforced** (7 kinds, 3 stages) |
| `presetTools` | string[] | — | Tool allow-list applied by an agent preset (can only narrow) |
| `batchBaseUrl` | string | provider base URL | Gateway that supports the Batch API |
| `batchEndpoint` | string | built-in | Batch protocol endpoint override |
| `batchWindow` | string | built-in | Batch `completion_window` override |

---

## See also

* [`docs/CONFIG.md`](CONFIG.md) — the canonical Chinese reference this file mirrors.
* [`SECURITY.md`](../SECURITY.md) — threat model and the security posture in English.
* [`README.en.md`](../README.en.md) — install, quickstart and the English doc index.
* [`docs/PROVIDERS.md`](PROVIDERS.md), [`docs/PACK-API.md`](PACK-API.md), [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).
