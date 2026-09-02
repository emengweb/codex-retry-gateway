# build.md

## 环境要求

- Windows 需要 PowerShell 5.1+ 或 PowerShell 7+
- macOS / Linux 需要 `bash`
- Node.js 18+

## 直接运行网关

```powershell
node .\gateway.mjs --config .\config.example.json
```

## 推荐用法

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1
```

macOS / Linux:

```bash
bash ./scripts/launch-ui.sh
```

说明：

- 第一次运行会自动安装并接管当前 Codex provider；如果 Codex 配置不存在，则从 pi、OpenCode、ZCode 中发现兼容 provider 并启动 client-only gateway
- 再次运行会先核对 provider、配置、PID 与 health：无变化且健康时零写入、零重启；停止时拉起；配置迁移时才重启
- client-only 运行会在复用启动时发现并接管新出现的兼容 provider，恢复时只还原仍指向 gateway 的字段
- provider 漂移时只恢复 gateway 接管；恢复备份缺失且当前 provider 指向真实上游时，会先保存该真实配置；切换 provider 时不会复用另一 provider 的备份
- PID 必须与 health 返回的 `process_id` 一致才允许停止；陈旧 PID 不会终止无关存活进程
- 手工 install 与 launch 共用恢复控制面；直接 start 也先验证 PID；新进程 health 必须回报自己的 `process_id`
- 新 child 从 PID 写入开始进入 start 清理事务；写入/启动验证失败时自行终止，确认退出后才清理仍指向该 child 的 PID 文件
- `config.json` 丢失但旧 gateway 健康时会从状态接口恢复运行时配置；目录型恢复点会在停机前被拒绝
- stop/restore 遇到缺失配置时会从 state 地址恢复进程身份，无法验证时不会删除 PID/state 或继续恢复
- 配置迁移启动失败会恢复旧文件，并在迁移前实例健康时按旧配置重新拉起
- 不依赖 `cc-switch` 安装本体，也不依赖 `cc-switch` 路由模式
- macOS / Linux 入口依赖 `bash` 和 `Node.js 18+`
- 推荐显式使用 `bash ...sh`，避免跨平台复制后可执行位丢失

## 只启动不自动开浏览器

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1 -NoOpen
```

```bash
bash ./scripts/launch-ui.sh --no-open
```

## 手工安装入口

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-for-current-provider.ps1
```

macOS / Linux:

```bash
bash ./scripts/install-for-current-provider.sh
```

## 恢复原配置

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-codex-config.ps1
```

macOS / Linux:

```bash
bash ./scripts/restore-codex-config.sh
```

## Make 生命周期命令

如果本机安装了 GNU Make，可以直接使用统一的停止/恢复入口：

```bash
make stop
make restore
```

`make stop` 只停止并清理受管 gateway 的 PID 文件，不修改 Codex、pi、OpenCode 或 ZCode 配置；`make restore` 会先校验恢复条件，停止 gateway，再恢复仍指向 gateway 的配置字段并删除安装状态。恢复遇到外部改写时会失败并保留状态，避免覆盖用户修改。

自定义运行目录或 Codex 配置路径时：

```bash
make stop STATE_ROOT="D:/codex retry gateway"
make restore STATE_ROOT="D:/codex retry gateway" CODEX_CONFIG_PATH="D:/codex/config.toml"
```

Windows 也可以使用 `make`、`mingw32-make` 或对应的 GNU Make 命令；参数通过 `STATE_ROOT`、`CODEX_CONFIG_PATH` 和 `ARGS` 传递。

## 打开管理页面

```text
http://127.0.0.1:4610/__codex_retry_gateway/ui
```

页面支持：

- 打开 TG 群入口：`https://t.me/AI_INPUT_IM`
- 查看当前接管状态
- 查看本次启动以来的实时日志
- 查看当前规则命中总数、实际拦截总数与实际拦截占比
- 查看 reasoning 行为统计大盘、高频 token 排行、候选特征组合与最近样本
- 查看 reasoning 统计里的按模型家族、按思考等级、按模型家族+思考等级分桶
- 按统一 Profile 运行 reasoning 特征分析，展示 `analysis_value`、`conclusion`、字段覆盖率、候选摘要和基线对比
- 导出 reasoning 行为统计 JSON / CSV
- 启动历史导入预检并分析后台任务，先判断历史数据是否具备 reasoning 行为特征分析价值
- 管理页热更新 `intercept_rule_mode` / `reasoning_match_mode` / `reasoning_equals` / `stream_action` / `endpoints` / `non_stream_status_code` / `guard_retry_attempts` / `capacity_error_action` / `http_429_action` / `model_unavailable_error_action` / `http_502_503_error_action` / `other_http_4xx_error_action` / `other_http_5xx_error_action` / `error_message_fallback_action` / `transient_retry` / `latency_guard` / `log_match`
- `continuation_marker_text` 支持配置/API 保存，当前管理页不单独提供输入框
- 一键恢复 Codex 原设置并关闭 gateway

拦截规则模式说明：

- `reasoning_tokens` 是默认并推荐的稳定主规则；默认 `reasoning_match_mode=formula_518n_minus_2`，会匹配 `516、1034、1552、2070...` 等所有符合公式的值。
- `reasoning_match_mode=manual` 会切回手动 `reasoning_equals` 列表；公式模式下 `reasoning_equals` 只保留为回退/参考列表。
- `final_answer_only_high_xhigh` 是实验收窄规则，仅在 `reasoning.effort=high/xhigh` 下拦截 `final answer only + commentary not observed + no tool call + no reasoning item`，且 `reasoning_tokens=null/缺失` 或非 0 的响应结构；普通 `reasoning_tokens=0` 只观察落盘，不触发该实验规则。它可能漏掉仍影响正确性的 516 样本，不建议替代默认 516/1034/1552 主拦截。
- `none` 不使用 reasoning 规则，直接透传正常流式响应并继续全量采集；Capacity、HTTP 429 与响应超时仍可独立叠加。
- 三个规则模式三选一；`intercept_streaming` / `intercept_non_streaming` 只控制命中当前 reasoning 规则后是否真正拦截。
- `stream_action=continuation_recovery` 是流式命中动作，不是拦截规则；仅在 `reasoning_tokens` 主规则命中时，对 `/responses` 与 `/v1/responses` 的流式响应尝试内部续写。`final_answer_only_high_xhigh` 实验规则不触发安全续写，只共用 `guard_retry_attempts` 做普通内部重试/最终拦截。续写请求会删除 `previous_response_id`，只显式 replay 原始 input 并追加 `phase=commentary` 标记，默认不自动请求 `reasoning.encrypted_content`，续写 replay 会过滤原始 input 中的 reasoning item / `encrypted_content`，安全模式下即使原请求显式 include 且本轮未命中，也会在普通下游响应体和本地请求摘要中剥离 `encrypted_content`，`request_kind=context_compaction` 除外；包括 Capacity/429 透传错误体；也不 replay 命中轮 encrypted reasoning item，不限定特定 token 公式。
- `guard_retry_attempts` 默认 `5`，可取 `0..32`，是单个客户端请求共享的内部追加尝试预算；reasoning 普通重试、Responses 续写恢复、Capacity、HTTP 429 与首 progress 超时重试都共用这里。
- `stream_action=continuation_recovery` 复用 `guard_retry_attempts` 控制最大安全续写次数；安全续写后的后续轮如果再次命中，会继续安全续写，耗尽后仍命中才返回拦截状态；各命中轮 lifecycle / reasoning item / tentative final answer / message / tool call / convenience `output_text` 不透给客户端，最终下游 SSE 以干净完成轮的 lifecycle 为准。
- `remote_compaction_v2` 只是 beta feature 标记，不单独识别为压缩请求；`x-codex-turn-metadata.request_kind=compaction`（以及兼容的显式 `context_compaction` 标记）会规范化为协议专用压缩请求，所有响应都豁免 reasoning 拦截、内部重试与续写恢复，并原样保留压缩 item 的 `encrypted_content`，确保上游压缩输出不被清空或替换；普通 turn 的 `516/1034/1552` 等命中值仍按当前规则处理并受 `guard_retry_attempts` 控制。
- `capacity_error_action` 默认 `retry_then_pass_through`，只精确匹配既有 Capacity 错误；`http_429_action` 默认 `pass_through`，处理剩余通用 HTTP 429 并遵守 `Retry-After`。模型未配置/不可用、HTTP 502/503、其他 HTTP 4xx、其他 HTTP 5xx 与 `error.message` 兜底各有独立动作，默认均为 `retry_then_pass_through`。所有动作支持 `pass_through`、`return_502`、`retry_then_pass_through`、`retry_then_502`；默认开启的 `transient_retry` 对可恢复故障优先，关闭它后才使用这些动作的共享重试预算。
- `transient_retry` 默认 `{ enabled: true, initial_delay_ms: 1000, max_delay_ms: 600000 }`：`429/502/503/504`、其它常见临时 4xx/5xx、结构化容量/额度/用量/Token Budget 错误、连接超时/重置，以及首写前流式断流会在同一客户端请求内自动重试。明确的 HTTP `200` `{ "error": { ... } }` 容量/额度包络同样可恢复，正常输出文本仅提到额度或 Token Budget 不会被误重试。退避采用指数增长加抖动，单次等待最多 10 分钟，单个客户端请求最多发起 `16` 次上游尝试，不消耗 `guard_retry_attempts`。
- 自动重放的安全边界是“客户端尚未收到任何响应”：流式一旦已写 header 或正文，不再重放，以免重复文本、工具调用或 SSE envelope；此后异常只能断连。客户端主动断开或 gateway 进程退出后，不能脱离原 HTTP 会话继续重试。
- `latency_guard` 默认关闭；首个有效输出超时可直接 502 或按共享预算重试后 502，总 deadline 跨 attempt 不重置。已经透传后不能改写 502，只能断连并落盘。
- `endpoints` 同时限定 reasoning、Capacity、HTTP 429 与 latency guard；列表外路径必须全部旁路这些策略。
- 两个 latency 阈值只接受 `0..2_147_483_647` 的整数；Retry-After 等待中命中总 deadline 必须复用当前 attempt 返回 timeout 502，不能静默结束或重复落盘。
- timer 回调不是 deadline 的唯一真源；非流式 JSON/脱敏、流式 SSE/结构解析、每个 chunk、EOF、reader 异常、retry 派发与客户端写入前都必须按绝对时间复核。流式 chunk 必须先收口检查上限，再按 total、first-progress 顺序复核；测试要让前几个 lifecycle 在 deadline 前到达、后续 lifecycle 首次跨线，不能只测首 chunk 已过期。
- reader 发生预期终止时，模型归档、日志、错误体和可撤回 header copy 完成后，必须在 `writeHead` 或前导缓冲 flush 前再次按 `total -> first-progress` 复核；跨线后只能落 timeout 结果，不能返回普通 termination 502 或 lifecycle 200。
- `client_first_write_at_ms` 表示真实客户端写入时刻，必须在 header copy 与 `writeHead` 完成后、紧邻 `res.write()` 记录；不得复用上游 chunk 到达或缓冲 flush 开始时间，也不得早于 `client_headers_sent_at_ms`。
- Capacity/429、reasoning、续写和首 progress retry 共用统一 pending 派发闸门；header/request 等同步准备必须在最终 deadline 复核和 current 首 progress 计时之前完成，真实 fetch 启动后才增加共享预算、代理总数和 active。旧 attempt 的结束时间/日志范围在 retry 决策时捕获，下一 fetch 启动并让出两个有界事件循环轮次后立即落盘，不得等待下一响应头。过期分支不得保留新 attempt 样本。
- Capacity/429 的 trigger 在分类时计数，retry/pass-through/502 在动作确定时分别计数；Retry-After 等待被客户端断连或 total deadline 中断时，trigger 仍必须保留且 retry 不得增加。
- Windows canonical 配置比较必须保留字符串、数字、布尔数组的值和顺序，同时只忽略对象键顺序。
- SSE framing 必须覆盖字段名与 JSON 跨 chunk、fallback 后尾随候选、独立/同块/UTF-8 字节级跨 chunk 的 BOM、首个事件即超大的误标候选、LF/CR/CRLF 混合空行和 EOF 纯 CR 终态；检查上限优先于同一 chunk 中迟到的 first-progress timeout；reasoning 保护下的超大事件在未写响应时返回专用 502，在已写响应时 fail-closed 断连；EOF 才命中的 disconnect 规则也必须实际断连。
- 每个真实 fetch 已启动的 attempt 必须且只能归入 inspected、bypassed、failed 或 active；未派发候选不得增加 inspected 或持久化伪 attempt，模型洞察每个 attempt 只提交一次；已有前序 inspected attempt 时，后续 fetch failure 仍单独增加 failed，保持 `total = inspected + bypassed + failed + active`。
- none + latency guard 的首 progress 前导缓冲是严格 `1MiB` 硬上限；越界 chunk 不能先进入缓冲数组。
- `retry_upstream_capacity_errors` 只用于旧配置迁移；新动作字段是最终真源。

reasoning 统计落盘说明：

- 代码层已实现 reasoning analytics，但当前正在运行的旧 gateway 进程不一定已经加载新代码。
- 如果 `GET /__codex_retry_gateway/api/analytics/reasoning` 返回上游 HTML 或非 JSON，说明需要在合适窗口重启或重新拉起 gateway 后再验证。
- 不要在正在承载重要 Codex 会话时贸然重启路由进程；先确认可以中断再操作。
- 每次请求都会尽量记录详细样本，不只记录最终透传成功的请求。
- 已覆盖：
  - 正常透传样本
  - 命中规则但仅观察样本
  - 最终被 gateway 拦截样本
  - gateway 内部重试样本
  - 未纳入检查但被旁路透传的请求样本
  - Codex `remote_compaction_v2` 上下文压缩样本
  - 上游 `fetch failed` 失败样本
  - 本地请求体超限拒绝样本
- 单样本会尽量保留：
  - 请求模型、模型家族、`reasoning.effort`
  - 请求类型 `request_kind`、拦截豁免原因 `intercept_exempt_reason`
  - 本地期望模型 / 上游声明模型 / 流式声明模型 / 最终响应模型
  - 请求摘要、请求体大小、请求体哈希、截断后的部分请求预览
  - token、耗时、TPS、响应结构特征
  - 命中规则、是否拦截、最终动作、上游状态、客户端状态
  - 截断后的失败摘要或响应摘要
- 导出脱敏要求：
  - 不导出 Authorization、Cookie、Set-Cookie、完整请求体、完整响应体。
  - 请求预览建议上限 `500` 字符。
  - 失败摘要、响应摘要和错误消息建议上限 `320` 字符。
  - CSV 优先导出结构字段、数值字段和状态字段。

历史导入分析说明：

- 历史导入独立于实时 reasoning analytics，不会把历史大文件完整写入 `reasoning-behavior-YYYY-MM-DD.json`。
- 默认发现本机 `%USERPROFILE%\.cc-switch\cc-switch.db`、`%USERPROFILE%\.codex\sqlite\logs_2.sqlite`、`%USERPROFILE%\.codex\logs_2.sqlite` 和 `%USERPROFILE%\.codex\sessions`。
- 如果请求体传入 `source_paths`，只分析指定路径，不混入默认真实大库，便于测试和分段导入。
- 历史导入先执行 preflight；缺少 `reasoning_tokens`、`final_answer_only`、`commentary_observed` 等核心字段时，标记 `no_analysis_value` 并停止候选特征分析。
- CC Switch / Codex logs SQLite 使用聚合 SQL；session JSONL 第一版只做文件级索引和 top 大文件，不深解析完整会话正文。
- 输出摘要写入 `<state_root>\analytics\imports\<job_id>\summary.json`，UI 只轮询任务进度和摘要。

并发与日志说明：

- gateway 是本机 Node.js 单进程异步代理，适合 Codex 本地路由和少量并发请求。
- 日志在同一进程内通过单个 `WriteStream` 追加写入；当前模型下不会多进程抢写同一个日志文件。
- 严格流式拦截会缓存 SSE，请求体也会先读入内存；严格模式累计 SSE 缓冲硬限制为 `8 MiB`，超过时在未首写前返回专用 `502`。高并发或大响应场景仍需要额外压测、日志轮转和内存上限治理。

## 本地验证

直接运行 Node 测试入口：

```powershell
node .\scripts\test-gateway-e2e.mjs
node .\scripts\test-content-encoding.mjs
node .\scripts\test-memory-guard.mjs
node .\scripts\test-install-restore.mjs
node .\scripts\test-client-configs.mjs
node .\scripts\test-client-only-install.mjs
node .\scripts\test-makefile.mjs
node .\scripts\test-launch-ui.mjs
node .\scripts\test-launch-ui-unix.mjs
node --check .\gateway.mjs
node --check .\scripts\test-content-encoding.mjs
node --check .\scripts\test-memory-guard.mjs
node --check .\scripts\admin-lib.mjs
node --check .\scripts\test-gateway-e2e.mjs
node --check .\scripts\test-install-restore.mjs
node --check .\scripts\test-launch-ui.mjs
node --check .\scripts\test-launch-ui-unix.mjs
node --check .\scripts\test-makefile.mjs
git diff --check
```

四套 E2E 会创建和清理临时 gateway、PID 文件与健康端口，必须按上面顺序串行执行，不要并行运行 `test-launch-ui.mjs` 与其它进程生命周期测试。Codex Desktop 默认 Node 出现后台子进程不退出时，可显式使用：

```powershell
& 'C:\Users\dashuai\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\test-gateway-e2e.mjs
```

涉及 PowerShell 变更时继续执行 AST 解析：

```powershell
$files = @('.\scripts\common.ps1', '.\scripts\install-for-current-provider.ps1', '.\scripts\launch-ui.ps1')
foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $file), [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "$file PowerShell AST 解析失败: $($errors[0].Message)" }
}
```

PowerShell 包装入口：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-launch-ui.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test-launch-ui-unix.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test-gateway-e2e.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test-install-restore.ps1
```

## GitHub Actions 按需验证

- 工作流：`.github/workflows/macos-smoke.yml`
- 目的：在 `macos-latest` runner 上补一层真实 macOS / Unix 入口冒烟
- 当前状态：仓库侧已手动禁用，默认不在 push / PR 时自动运行；常规验收优先使用上面的本地验证命令
- 当前命令：

```bash
node ./scripts/test-launch-ui-unix.mjs
```

## 本机真实验证命令

以下命令会访问当前 `127.0.0.1:4610` 上实际运行的 gateway，只作为可选实机验证；需要维护窗口，不属于 PR 合并前必跑项，也不要在承载重要 Codex 会话时贸然执行重启/切换类操作。

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/health'
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/ui'
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning'
```

成功标准：

- HTTP 状态为 `200`。
- 响应 `Content-Type` 是 JSON 或正文可解析为 JSON。
- JSON 中包含 `ok: true`、`summary`、`top_reasoning_tokens`、`candidate_patterns`、`recent_samples`。
- JSON 中包含 `schema_version: 3`、`analytics_ready: true`、`analytics_started_at`、`analytics_state_root` 这类机器可判定信号。
- 如果返回 HTML，表示当前运行实例不是已加载 analytics 的新版 gateway。

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=json'
```

成功标准：

- HTTP 状态为 `200`。
- JSON 中包含 `schema_version`、`exported_at`、`summary`、`samples`。
- JSON 中包含 `analytics_ready: true`。
- 不应包含完整 prompt、完整 answer 或 Authorization。
- `31` 天以内保持同步导出；`32` 天及以上应返回 `202` 并创建后台导出任务。
- 后台导出任务应按日期分段处理，UI 显示进度条和“可以继续正常使用 gateway”的提醒，完成后提供下载链接。

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=csv'
```

成功标准：

- HTTP 状态为 `200`。
- CSV 表头至少包含 `sample_id`、`gateway_request_id`、`request_kind`、`intercept_exempt_reason`、`request_reasoning_effort`、`reasoning_tokens`、`duration_total_ms`、`output_tps`、`commentary_observed`、`client_http_status`、`policy_trigger`、`policy_action`、`retry_trigger`、`retry_delay_ms`、`timeout_phase`、`timeout_limit_ms`、`response_forwarding_started`。

时间段观测示例：

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning?date_from=2026-06-29&date_to=2026-06-30'
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=json&date_from=2026-06-29&date_to=2026-06-30'
```

reasoning 特征分析示例：

```powershell
$body = @{
  filters = @{
    include_retries = $true
    include_blocked = $true
  }
  conditions = @{
    reasoning_tokens = @(516)
    final_answer_only = $true
    commentary_not_observed = $true
    time_normalization_deviation = 'high'
  }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/analyze'
```

成功标准：

- HTTP 状态为 `200`。
- JSON 中包含 `analysis_profile=516_candidate_review_v1`。
- JSON 中包含 `analysis_value`、`conclusion`、`field_coverage`、`candidate_summary`、`baseline_comparison`。
- 结论只表示候选复盘等级，不修改现有拦截规则。

落盘文件检查：

```powershell
Get-ChildItem (Join-Path $env:USERPROFILE '.codex-retry-gateway\analytics') -Filter 'reasoning-behavior-*.json'
```

成功标准：

- 重启并产生请求后，目录里出现 `reasoning-behavior-YYYY-MM-DD.json`。
- 文件内 `schema_version` 为 `3`。
- `samples` 中能看到模型、模型家族、`request_reasoning_effort`、token、耗时、TPS、状态、重试、策略动作、客户端首写和 timeout 字段。

反例验证口径：

- 旧进程返回 HTML 或非 JSON 时，不能视为 analytics 已激活。
- 缺少 `schema_version` 或 analytics ready 信号时，只能视为部分可用，不能视为完整激活。
- 大时间段观测查询超过 `7` 天时，应返回 `degraded=true` 和 `degrade_reason=date_range_too_large`，不能全量深解析到卡死。
- JSON / CSV 导出超过 `31` 天时，不应阻塞 UI 或代理主链路；应返回 `202`、`background_export=true` 和 `export_job.job_id`，由前端轮询任务进度并在完成后下载。

后台导出任务检查示例：

```powershell
$job = Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=json&date_from=2026-01-01&date_to=2026-03-15'
$job.export_job
Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export/jobs/$($job.export_job.job_id)"
```

成功标准：

- 创建请求返回 HTTP `202`。
- `export_job.progress.total_days` 等于选择的本地日期天数。
- `processed_days` 会随后台处理推进，完成后 `status=completed`。
- 完成后 `download_url` 指向 `/api/analytics/reasoning/export/jobs/<job_id>/download`。
- 导出期间普通代理请求不需要等待该任务完成。

历史导入分析任务检查示例：

```powershell
$job = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/run'
$job.import_job
Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/jobs/$($job.import_job.job_id)"
Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/latest'
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body (@{ job_id = $job.import_job.job_id } | ConvertTo-Json) -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/analyze'
```

成功标准：

- 创建请求返回 HTTP `202`。
- `import_job.progress.total_sources` 表示本次发现或指定的数据源数。
- 任务完成后 `status=completed`，`preflight.analysis_value` 为 `valuable`、`partial` 或 `no_analysis_value`。
- `feature_analysis` 中包含 `analysis_profile`、`analysis_value`、`conclusion`、`field_coverage`、`candidate_summary` 和 `baseline_comparison`。
- `no_analysis_value` 表示历史源缺核心字段，应放弃候选特征分析；此时可以保留轻量摘要，但不要求展示 CC Switch 模型深聚合。
- `valuable` 或 `partial` 时，`summary` 中包含请求量、token、日志行数、session 文件数等摘要，且仍不读取完整 prompt、完整 answer、Authorization 或 Cookie。
- 导入期间普通代理请求不需要等待该任务完成。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1 -NoOpen
```

```powershell
$auth = Get-Content -Raw (Join-Path $env:USERPROFILE '.codex\auth.json') | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($auth.OPENAI_API_KEY)" }
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/v1/models' -Headers $headers
```

```powershell
codex exec --ephemeral --skip-git-repo-check --color never --dangerously-bypass-approvals-and-sandbox -m gpt-5.4-mini -C $env:TEMP --output-last-message (Join-Path $env:TEMP 'codex-retry-gateway-clean-smoke.txt') '只回复OK'
```

```bash
bash ./scripts/launch-ui.sh --no-open
```
