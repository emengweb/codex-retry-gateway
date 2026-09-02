# err.md

## 2026-09-02 多客户端恢复边界与 provider 误接管

### 现象

- 安装状态中的 Codex 恢复备份路径如果是符号链接，旧校验会跟随链接并将其目标当成有效备份。
- pi/OpenCode/ZCode provider 的兼容性判断只要任意标记包含 `openai` 就通过，可能将原生 `openai-responses` provider 接管到当前非协议转换 gateway。

### 根因

- Codex 控制面和管理页恢复入口使用 `stat` 判断备份是否为文件；`stat` 会解析符号链接。
- 多客户端发现把“包含 OpenAI 名称”误等同于“当前 gateway 可代理的 OpenAI-compatible 协议”。

### 处理

- Codex 备份改用 `lstat`，只接受非符号链接的普通文件；管理脚本与管理页恢复入口采用同一边界。
- 自动接管仅接受 `openai-completions`、`openai-chat-completions` 或带 `openai-compatible` 标记的 provider；原生 `openai-responses` 保持不变。
- 恢复先执行客户端字段预检，且只有仍指向本次 gateway 的记录才会被恢复，外部改写保持冲突而不覆盖。

### 防回归

- `node .\scripts\test-client-configs.mjs` 覆盖原生 `openai-responses` 不被接管及兼容 provider 恢复。
- `node .\scripts\test-install-restore.mjs` 覆盖目录型恢复点拒绝、Windows 有符号链接权限时的链接恢复点拒绝；无权限环境会明确输出跳过原因。
- `node --check .\gateway.mjs`、`node --check .\scripts\admin-lib.mjs`、`git diff --check` 验证语法与补丁格式。

## 当前默认值说明

- 早期排错记录里出现的 `guard_retry_attempts=3` 是历史默认；当前项目默认以 `gateway.mjs`、`config.example.json`、`README.md` 和 `build.md` 为准，默认值已经调整为 `5`。
- `stream_action=continuation_recovery` 只让 `reasoning_tokens` 主规则命中的 Responses 流式请求进入安全续写；`final_answer_only_high_xhigh` 实验规则即使选择该动作，也只共用 `guard_retry_attempts` 做普通内部重试/最终拦截。

## 2026-08-11 remote compaction v2 被拦截或脱敏后返回零输出 item

### 现象

- Codex 持续报错：`remote compaction v2 expected exactly one compaction output item, got 0 from 0 output items`。
- 真实请求带 `x-codex-beta-features: remote_compaction_v2` 和 `x-codex-turn-metadata.request_kind=compaction`；若 gateway 把它当普通 turn，或把唯一 item 的 `encrypted_content` 清洗掉，远程压缩协议会收到 0 个有效输出 item。

### 根因

- 旧请求分类只识别 `remote_compaction` / `context_compaction` 文本标记，未解析真实 header JSON 中的 `request_kind=compaction`，因而把远程压缩请求归为普通 turn。
- 被归为普通 turn 后，`reasoning_tokens=516` 等值会进入普通 reasoning 拦截与续写恢复链路，压缩输出可能被重试、替换或清空。
- `continuation_recovery` 的 Responses 安全清洗原先不区分请求类型，连 `type=compaction` 的协议 item 也删除 `encrypted_content`；客户端因此无法识别唯一压缩 item。

### 处理

- 对已由显式请求信号识别的 `request_kind=context_compaction` 无条件豁免所有 reasoning 拦截模式。
- 压缩样本仍完整记录并带 `intercept_exempt_reason=context_compaction`，但不触发 reasoning 内部重试或续写恢复。
- 从结构化 `x-codex-turn-metadata` / 请求 JSON 的 `request_kind=compaction` 识别真实压缩请求；beta 标记本身仍不构成压缩识别条件，显式标记为普通 turn 的请求继续遵守现有主规则。
- 压缩请求跳过 `encrypted_content` 响应脱敏，普通请求仍保持原有敏感内容保护。

### 防回归

- `scripts/test-gateway-e2e.mjs` 覆盖 `context_compaction + reasoning_tokens=516`：必须返回 `200`、仅发起一次上游请求、样本不命中规则且标记为压缩豁免。
- 同一 E2E 还覆盖 `request_kind=compaction` 在 `continuation_recovery` 下保留唯一 `compaction.encrypted_content` item。
- 验证命令：`node --check .\\gateway.mjs`、`node --check .\\scripts\\test-gateway-e2e.mjs`、`node .\\scripts\\test-gateway-e2e.mjs`。

## 2026-08-11 持续内部重试与严格流缓存导致内存快速上涨

### 现象

- 实机日志出现连续的 `upstream-other-http-4xx ... action=internal_retry`，同一 `/responses` 请求在毫秒级重复派发；配置中曾存在 `guard_retry_attempts=9999`。
- 管理接口已将运行配置改为安全值后，先前已经进入循环的请求仍持有旧配置对象；进程 RSS 继续升高，健康接口会超时。
- 严格流式模式会积累完整 SSE 后再决定是否向客户端首写；分析样本每日落盘后也一直保留在 `daily_buffers`，长运行进程会重复占用已写入磁盘的样本内存。

### 根因

- `guard_retry_attempts` 只校验非负整数，没有上限；`transient_retry` 在 `429`、临时 HTTP 错误、连接失败和首写前流式失败上没有请求级尝试次数上限。
- `strict_502` / `continuation_recovery` 的累计 `bufferedChunks` 没有总字节限制。
- 分析落盘函数写文件成功后没有释放对应日期的内存数组。

### 处理

- `guard_retry_attempts` 限制为 `0..32`；安装/复用迁移同样会将超过上限的旧值恢复为默认值。
- `transient_retry` 每个客户端请求最多发起 `16` 次上游尝试；达到上限后不再重放，交给最后一次响应的既有策略处理。
- 严格流式累计缓存限制为 `8 MiB`，超限且尚未首写时返回 `response_inspection_limit_exceeded` 的 `502`。
- 每日分析样本在落盘前做快照，成功后释放内存；落盘失败会把快照与期间新增样本合并回缓冲，避免丢样本。
- 配置保存改为原地更新运行时配置对象，使已经持有该对象的重试循环能读取紧急关闭/收口配置；旧进程未加载此代码时仍必须受控重启。

### 防回归

- `node .\scripts\test-memory-guard.mjs` 覆盖：超过 `32` 的 guard 预算拒绝启动、连续 `429` 在第 `16` 次上游尝试后收口、严格流累计超过 `8 MiB` 返回专用 `502`、分析样本落盘后 `daily_buffers` 清空、管理接口紧急关闭临时重试后在途请求不再沿用旧配置循环。
- `node --check .\gateway.mjs && node --check .\scripts\test-memory-guard.mjs && git diff --check` 覆盖语法和补丁格式。

## 2026-08-11 Codex 压缩请求必须在网关侧规范化

### 现象

- Codex 的新会话请求可能带 `Content-Encoding: zstd`；旧网关把压缩字节和该头部原样转发，依赖上游再次解码。
- 上游拒绝这类请求时，现有 `other_http_4xx` 重试策略还会把一次 `400` 放大成大量瞬时失败，导致错误频繁弹出。

### 根因

- `proxyRequest` 在解析 JSON 前没有处理请求体编码，`cloneHeadersForUpstream` 也保留了 `content-encoding`；网关自身无法保证下游使用同一套压缩解码器。

### 处理

- 网关现在对整条已知 `gzip`、`br`、`deflate`、`zstd` 编码链逆序解压，解压后复用同一份 body，并移除 `Content-Encoding` 让上游按 identity 读取。
- 解压后的 body 仍受 `request_body_limit_bytes` 限制；编码链过深或已识别编码损坏时，网关直接返回 `400 request_content_encoding_invalid`，不派发上游重试。运行时不支持某个编码时保持原请求，避免破坏旧 Node 运行时的既有兼容性。

### 防回归

- `node scripts/test-content-encoding.mjs` 覆盖 zstd 解压转发、移除编码头和 malformed zstd 不转发。
- `node scripts/test-gateway-e2e.mjs`、`node scripts/test-launch-ui-unix.mjs`、`node --check gateway.mjs` 与 `node --check scripts/test-content-encoding.mjs` 已通过。

## 2026-08-11 上游错误策略必须区分语义、状态码和流式首写边界

### 现象

- 上游可能返回 `{"error":"模型 'gpt-5.6-sol' 未配置或不可用"}`、HTTP `502/503`、其他 `4xx/5xx`，或 HTTP `200` 的 `{ "error": { "message": "..." } }` 错误包络；旧策略只覆盖 Capacity 与 HTTP 429。
- 流式 `response.failed` 可以在 HTTP `200` 内使用字符串形式的 `response.error`。若在读取前已经向客户端发送响应头，网关无法安全重放该请求。

### 根因

- 旧分类器没有从结构化 `error` 字符串和 `error.message` 提取可独立配置的错误信号，也没有把状态分类排除已拥有专属动作的 429、502、503。
- 流式首写前的延迟转发只由 `transient_retry` 驱动；关闭它后，即使新策略要求重试，也会先写出 HTTP 200 响应头。

### 处理

- 增加模型未配置/不可用、HTTP 502/503、其他 HTTP 4xx、其他 HTTP 5xx、`error.message` 兜底五项策略，默认均为 `retry_then_pass_through`；保留 Capacity 与 HTTP 429 原有开关和默认值。
- 保持 `transient_retry` 优先，随后按 Capacity、模型不可用、429、502/503、其他 4xx、其他 5xx、`error.message` 分类；429 不进入其他 4xx，502/503 不进入其他 5xx。
- 新策略复用 `guard_retry_attempts` 和既有策略延迟；流式仅在未发送头或正文时延迟转发并允许重试，已首写不再重放。
- 主题持久化扩展为 `light`、`dark`、`system` 三态；旧值兼容，`system` 使用 `prefers-color-scheme` 并监听运行期系统主题变化，不移动或重设主题按钮样式。
- 复审发现流式策略分类若扫描全部 SSE payload，会把 `response.completed` 的同名 `error.message` 元数据误当失败并触发重放。现在仅在 `response.failed`、`response.error`、`response.incomplete` 等明确失败终态运行策略分类。

### 防回归

- `node .\scripts\test-gateway-e2e.mjs` 覆盖五类非流式新策略、模型不可用 HTTP 200 错误包络、HTTP 429 排除其他 4xx、关闭模型策略后不重放、流式 `response.failed` 首写前模型不可用重试、管理页配置保存和 system 主题三态。
- E2E 额外覆盖携带 `error.message` 的 `response.completed` 不重试，防止普通 lifecycle 元数据触发错误兜底策略。
- `node --check .\gateway.mjs` 与 `node --check .\scripts\test-gateway-e2e.mjs` 覆盖主程序和测试脚本语法。

## 2026-08-10 临时 API 故障应保持同一请求并自动恢复

### 现象

- 上游 API 在容量不足、结构化额度或 Token Budget 错误、`429/502/503/504`、建连失败和流式首写前断流时，会让 Codex 会话直接返回错误，需要人工再次发送任务。
- 旧的 `guard_retry_attempts` 是 reasoning/Capacity/429 等策略的共享预算，不适合作为持续临时恢复的次数上限。

### 根因

- 旧网关只对少量策略错误或一次 fetch failure 处理重试，普通临时 `5xx`、结构化余额/用量错误和部分连接中断会直接回传。
- 流式请求必须区分是否已向客户端首写；首写后重放完整请求会造成重复文本、工具调用或 SSE lifecycle，不能用“无限重试”掩盖该协议边界。
- `200 + SSE response.failed` 的结构化额度事件虽然已被识别，但旧实现会中止当前 attempt 的 `AbortController`；后续等待把该内部中止误判为客户端断开，因而不会派发下一次上游请求。
- 若结构化额度识别扫描整个 JSON 包，普通 `invalid_request` 错误附带的文档或回显文本中的 `token budget` 会被误判为额度故障，导致永久错误进入无限重试。
- Capacity 识别也存在同类边界：结构化 `error` 对象之外的 `detail` / 回显字段提到 `model is at capacity` 时，不能覆盖真正的 `invalid_request` 语义。

### 处理

- 新增 `transient_retry`，默认开启：初始退避 `1000ms`，指数退避加抖动，单次等待硬限制 `600000ms`（10 分钟）。
- 识别 `408/425/429/500/502/503/504/520-524`、容量不足、结构化 `insufficient_quota` / `billing_hard_limit` / 用量与 Token Budget 错误，以及常见 socket/network 错误。
- 临时重试不消耗 `guard_retry_attempts`，持续到成功、客户端断开或 `latency_guard.total_timeout_ms` 到期；HTTP `Retry-After` 优先，但仍受 10 分钟上限限制。
- 仅在客户端未收到任何响应时重放完整请求；流式已首写后只允许断连，不能重放或拼接第二轮。
- 流式结构化失败只取消未转发的上游 reader，不中止用于等待重试的 attempt controller；HTTP `200` 只有明确 `{ "error": { ... } }` 的容量/额度包络才会重试，正常输出文本中提到 Token Budget 不会误触。
- 额度与 Token Budget 的结构化判断只读取明确 `error.type`、`error.code` 和 `error.message`，不扫描其他 JSON 字段；普通参数错误会原样回传。
- Capacity 判断在有结构化错误对象时只读取其 `type` / `code` / `message`；仅对无法解析为 JSON 的纯文本错误体扫描容量文案，避免辅助字段误触发。
- Node server 的请求超时关闭，避免 10 分钟内的正常等待被 Node 默认超时截断。
- Windows 安装与复用迁移会写入或规范化 `transient_retry`，上限始终钳制为 10 分钟。

### 防回归

- `node .\scripts\test-gateway-e2e.mjs` 覆盖 `502/503/504`、结构化 429/额度/Token Budget、HTTP `200` 结构化错误包络、正常文本不误重试、建连中断、流式 `response.failed` 与首写前断流的同一请求恢复。
- E2E 额外覆盖 `400 invalid_request_error` 的其他字段提到 Token Budget 时只发起一次上游请求并原样返回，防止误吞永久请求错误。
- E2E 同时覆盖结构化 `invalid_request_error` 的辅助字段提到 Capacity 时只发起一次请求，防止容量识别误吞永久请求错误。
- `node .\scripts\test-install-restore.mjs` 覆盖 Windows 默认配置与旧配置迁移；`node .\scripts\test-launch-ui-unix.mjs` 覆盖 Unix 控制面不回归。
- deadline 故障注入曾偶发在 lifecycle 跨线断言失败：首次 progress 的剩余时间因启动开销可计算为 `501ms`，而注入脚本只延迟到 `500ms`，使真实 timer 抢在预期的跨线 lifecycle 前中止。注入范围已覆盖到 `550ms`，保留“前序 chunk 必须在 deadline 前送达、后续 chunk 必须实际跨线”的断言。pending retry 仍保持“先发起真实 fetch、再归档旧样本”顺序，禁止回退为在派发前做同步归档。
- 2026-08-10 再次发现 lifecycle 跨线断言的时间基准不一致：假上游的 `received_at_ms` 比 gateway 的真实 `upstream_fetch_started_at_ms` 晚数毫秒，导致实际已跨 gateway deadline 的 chunk 被误判为未跨线。回归断言改为使用样本记录的 `upstream_fetch_started_at_ms + 500ms`，同时验证假上游确实在该 deadline 前后各发出过 chunk；复验命令为 `node .\scripts\test-gateway-e2e.mjs`。
- 纯文本 `400 insufficient_quota: token budget exceeded` 不含 JSON `error` 包络，原有严格结构化判断会将其直接回传。现仅当响应无法解析为 JSON 时扫描纯文本额度/用量/Token Budget 信号；可解析 JSON 仍只读取 `error.type/code/message`。E2E 覆盖该纯文本错误自动恢复，以及结构化 `invalid_request_error` 附带 Token Budget 文案不重试。
- 临时建连中断或首写前 SSE 额度错误进入退避时，旧 attempt 的 `first_progress_timeout_ms` timer 曾继续 abort 当前 controller，导致等待尚未结束即返回 502。临时退避现在显式关闭旧 attempt 的首 progress 窗口，等待只受客户端断开和请求级 `total_timeout_ms` 限制；下一次真实 fetch 会创建新的首 progress 窗口。E2E 覆盖建连中断与 SSE 额度错误在 `120ms` 退避大于 `60ms` 首 progress 阈值时仍恢复成功。
- 复审发现 `transient_retry` 初版只在异常分支检查开关，遗漏了 `endpoints` 边界：列表外路径在开启时会绕过原有两次 fetch fallback，进入持续重试。现在只对 `matchPath(config, pathname)` 命中的请求启用持续重试；列表外路径保持原有有限 fallback。E2E 以 `/v1/models` 连续两次建连失败为例，断言仍只发起两次上游请求并返回 `502`。
- 复审又发现已解析的 JSON 标量（例如 JSON 字符串）不应回退扫描原始 body，否则 `400` 的普通说明文字提到 `model is at capacity` 时可能被误判为容量故障。容量文案兜底现仅用于无法解析的纯文本；E2E 覆盖 JSON 字符串提及 capacity 只发起一次请求并原样返回。
- 后续红测发现容量辅助函数虽然已避开外层 `detail`，却仍将完整 `error` 对象序列化扫描，导致 `error.details` 提及 `model is at capacity` 的 `400 invalid_request_error` 被错误重放。结构化容量判断现与额度判断一致，只读取 `error.type`、`error.code`、`error.message`；E2E 先确认该场景失败，再断言修复后只发起一次上游请求并原样返回 `400`。

## 2026-07-06 Responses 流式安全续写不能透出截断轮输出

### 现象

- `stream_action=continuation_recovery` 命中 516 / 1034 / 518*n-2 后，真实用户反馈续写结果会出现输出不完整或语义断裂。
- 本机 analytics 元数据显示，大量 `continuation_recovery` 样本在命中轮已经观察到 `has_output_text=true` / `has_final_answer=true`，说明命中轮可能已经吐出 tentative final / message / tool / reasoning 片段。
- 经过后续安全复盘，命中轮的 visible output、tool call、message、reasoning item 和 `encrypted_content` 都不能当成确定输出；不能为了“补全前半段”把命中轮片段拼接给客户端。

### 根因

- 续写恢复的目标不是保留命中轮片段，而是在命中当前规则后丢弃不可信轮，基于原始 input 发起安全续写。
- 旧讨论中“把前面非终止 SSE 片段带到最终响应”的思路会把降智/截断轮内容混入最终 envelope，导致同一个下游 SSE 混用不同 `response.id` / `model`，且可能透出 tentative tool / final / reasoning。
- 因此正确修复是：命中轮只作为触发信号；中间轮只计入观测和拦截统计，不进入客户端输出，也不进入下一轮续写上下文。
- 如果简单回退 `internal_retry`，会把“续写恢复”偷换成“重新生成”，不符合 `continuation_recovery` 的产品语义。

### 处理

- 为 Responses 流式续写增加安全语义折叠策略：
  - 命中续写前，不保留命中轮 lifecycle；reasoning item / message / final answer / function call / tool call 都视为 tentative output。
  - 截断轮所有可见/可执行输出命中后丢弃，不透给客户端，也不进入下一轮续写上下文。
  - 丢弃中间轮 `response.created` / `response.in_progress` / `response.completed` / `response.failed` / `response.incomplete` / `[DONE]`。
  - 最终干净轮返回时，保留最终轮自带 lifecycle、输出、`response.completed` 与 `[DONE]`。
  - 不混用命中轮与最终轮的 `response.id` / `model`，避免一个下游 SSE envelope 身份不一致。
- 续写请求删除 `previous_response_id`，只显式 replay 原始 input 并追加 `phase=commentary` 标记；默认不自动请求 `reasoning.encrypted_content`；原始 input 中的 reasoning item / `encrypted_content` 会在续写 replay 前过滤；请求摘要对畸形 JSON 也按敏感文本 fail-closed 脱敏；命中轮 encrypted reasoning item 不 replay 到下一轮，也不再作为继续安全续写的必要门槛。
- Responses 流式续写安全模式继续复用 `stripEncryptedContentFromSseBody()`，即使原请求显式 include `reasoning.encrypted_content` 且本轮未命中，最终透传响应也不向客户端暴露 `encrypted_content`；畸形 SSE / JSON fallback 中疑似敏感片段会被 redacted。
- 不改变拦截规则、不改变 `guard_retry_attempts` 语义、不把续写恢复降级成普通内部重试。

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `续写恢复第二轮请求应删除 previous_response_id，续写状态由显式 input replay 承载`
  - 语义 fold 断言覆盖：截断轮 `fold-part-a` 不应透出，截断轮 `function_call` / `call_test_1` / tool arguments 不应透出，最终干净轮 `fold-part-b` 与 `[DONE]` 必须保留。
  - 多 agent 审查补充红测：`516 -> 1034 -> 128` 中，516 / 1034 连续命中都继续安全续写；第 2 / 3 次续写请求都只能基于原始 input 追加 1 个 commentary marker；最终 SSE 的 `response.created` / `response.in_progress` / `response.completed` 必须全部来自最终干净轮；也不应透出 mixed `response.output_snapshot` 夹带的 `snapshot-tentative-final`。另补 `516 -> 1034 -> 18` 耗尽用例，确认次数耗尽后仍命中返回 `502` 且不透出中间轮 SSE。
- 修复后：
  - `node --check .\gateway.mjs`
  - `node --check .\scripts\test-gateway-e2e.mjs`
  - `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-06 Responses 流式安全续写的 encrypted_content 脱敏边界

### 现象

- 多 agent 复审发现多个隐私边界：
  - `stream:true` 请求如果上游返回 `text/plain` / 非 JSON / 非 SSE，响应体没有 `data:` 行时会绕过 SSE JSON 脱敏，可能把 `encrypted_content` 原样透给客户端。
  - 畸形 JSON 请求体如果 `encrypted_content` 的值是对象、数组或未加引号值，原文本脱敏只替换字段名，可能把敏感值落入 `request_payload_excerpt`，并随 JSON / CSV 导出。
  - 畸形 JSON 请求体如果把 key 写成 `\u0065ncrypted_content` 这类 escaped-letter 形式，旧归一化只能识别 `\u005f`，会把 key 和敏感值一起落盘。
  - SSE block 有合法 `data:` 行时，旧逻辑只清理 data payload，`event:` / `id:` / comment 这类 non-data 行如果带 `encrypted_content=...` 会原样透传。
  - 历史 day file、同步导出、后台导出下载都应在出口再做一次脱敏，不能假设早期样本一定已经干净。

### 根因

- `stripEncryptedContentFromSseBody()` 对无 `data:` 的普通文本块直接返回原文；有 `data:` 行时也只清理 data payload，没有处理 non-data metadata 行。
- `redactEncryptedContentText()` 之前主要覆盖 `encrypted_content: "字符串"`，对畸形对象 / 数组值无法确定边界，也没有处理 `encrypted_content=...` 这类 KV 形式。
- `normalizeEscapedEncryptedContentKey()` 只把 `\u005f` 归一化为 `_`，不能识别 `\u0065ncrypted_content` 这类 escaped-letter key。
- `clonePlainSample()` 没有对 `request_payload_excerpt` 做出口二次脱敏，历史脏样本可能继续进入 JSON / CSV / 后台导出 / 日文件。

### 处理

- 文本脱敏改为扫描 `encrypted_content:` 后的值边界：字符串、对象、数组、未加引号值都会整体替换为 `"redacted_sensitive_content":true`。
- escaped ASCII unicode 归一化从只处理 `\u005f` 扩展为处理 `\u00xx` 级别的 ASCII key 片段；无敏感命中时保留原文，避免无关请求摘要被改写。
- `encrypted_content=...` 这类 KV 形式会把 key 和 value 一起替换为 `redacted_sensitive_content=true`。
- `stripEncryptedContentFromSseBody()` 遇到无 `data:` 但疑似包含 `encrypted_content` 的文本块时，也走同一文本脱敏路径；有 `data:` 行时，non-data 行也逐行脱敏。
- `clonePlainSample()` 对 `request_payload_excerpt` 做出口二次脱敏，覆盖内存样本、日文件 flush、同步 JSON / CSV 导出和后台导出下载。
- E2E 补充：
  - 畸形请求体中对象 / 数组 / 未加引号值 / escaped-letter key 不落 `request_payload_excerpt`，也不进入 JSON / CSV / 后台导出 / 日文件。
  - 同步 JSON / CSV、后台导出下载和日文件都同时断言“样本定位 key 仍存在”与“`encrypted_content` 字段名、escaped key、敏感值均不存在”，避免用空导出或过滤样本伪通过。
  - 后台导出测试使用覆盖当前日期的动态大范围日期段，仍触发后台任务，但不再固定在历史月份导致空测。
  - `stream:true` + `text/plain` fallback 不向客户端暴露 `encrypted_content` 或敏感值。
  - SSE metadata non-data 行不向客户端暴露 `encrypted_content` 或敏感值。

### 验证

- 红测先失败在：`对象/数组值畸形 JSON 请求摘要不应落盘 encrypted_content 字段或值`。
- 多 agent 复审补充红测后，先失败在：`escaped-letter key 畸形 JSON 请求摘要不应落盘 encrypted_content 字段或值`。
- 修复 escaped-letter 后继续失败在：`stream:true SSE metadata 行不应向客户端暴露 encrypted_content`，证明 KV value 仍会泄漏。
- reviewer 复审后又发现后台导出下载原测试固定 `2026-01-01..2026-03-15`，当前日期样本不会进入该范围，属于空测；已改成覆盖当前日期的动态 40 天范围，并断言导出样本数组包含畸形样本 key。
- 修复后通过：
  - `node --check .\gateway.mjs`
  - `node --check .\scripts\test-gateway-e2e.mjs`
  - `node .\scripts\test-gateway-e2e.mjs`
## 2026-07-02 reasoning 分桶表不应把 count=1 的 token 显示成“高频 token”

### 现象

- reasoning 行为统计里的三张分桶表：
  - 按模型家族
  - 按思考等级
  - 模型家族 × 思考等级
- 右侧原“高频 token”列会显示类似：
  - `0 x4, 516 x2, 8 x1`
- 当分桶样本较多且 reasoning token 分散时，`x1` 这类低频值被展示成“高频 token”，用户会误以为该列是完整、可靠的高频分布。

### 根因

- 后端 `summarizeGroupedSamples()` 固定取分桶内 `topReasoningTokensForSamples(samples, 3)`。
- 该逻辑只是 Top 3 摘要，不等于真正高频。
- 前端 `formatReasoningTokens()` 也没有过滤 `count=1`，导致低频 token 被画进“高频 token”列。

### 处理

- 分桶表改为展示“重复 token”：
  - 后端只返回分桶内出现次数大于 `1` 的 reasoning token。
  - 前端再次过滤 `count<=1`，兼容旧数据或旧缓存。
  - 没有重复 token 时显示 `无重复 token`。
- 全局“高频 token 排行”不变，因为它是独立的全局排行榜。

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `reasoning 模型家族聚合表不应把 count=1 的低频 token 显示为高频 token`
- 修复后：
  - `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-02 Issue #11：上游 Selected model is at capacity 应在网关内重试

### 现象

- 上游返回：
  - `Selected model is at capacity. Please try a different model.`
- 旧行为会把该错误直接透传给 Codex。
- 用户期望这类 capacity 响应由 gateway 内部吞掉并重试，减少会话被上游临时容量波动打断。
- 同时该能力必须能开关，避免策略效果不好时无法回退。

### 根因

- 旧的 `guard_retry_attempts` 只服务于“命中本地拦截规则”的响应。
- 上游真实 HTTP 错误此前按保守策略全部透传，避免误吞普通 `429` / `502`。
- Issue #11 的 capacity 文案是更窄的上游容量错误特征，可以单独处理，但不能泛化成“所有 429 都重试”。

### 处理

- 新增配置：
  - `retry_upstream_capacity_errors`
  - 默认 `true`
  - 管理页可开关，保存后热生效
- 开启后，仅当上游错误响应包含：
  - `Selected model is at capacity. Please try a different model.`
  - 且 HTTP 状态为错误状态时，才触发内部重试。
- capacity 内部重试与本地规则内部重试共用 `guard_retry_attempts`：
  - `0` 表示不重试，直接透传或按现有规则返回
  - 大于 `0` 时吞掉本次 capacity 响应并重新请求上游
- 普通 `429` / `502` 不匹配该文案时仍原样透传。
- 这类被吞掉的 capacity 响应会落 reasoning analytics 样本：
  - `final_action=upstream_capacity_internal_retry`
  - `blocked_by_gateway=true`
  - `matched_current_rule=false`

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `retry_upstream_capacity_errors 默认应为 true`
- 修复后：
  - `node --check .\gateway.mjs`
  - `node --check .\scripts\admin-lib.mjs`
  - `node --check .\scripts\test-gateway-e2e.mjs`
  - `node --check .\scripts\test-install-restore.mjs`
  - `node .\scripts\test-gateway-e2e.mjs`
  - `node .\scripts\test-install-restore.mjs`

## 2026-07-02 final answer only 模式不能拦截 Codex 上下文压缩请求

### 现象

- `final_answer_only_high_xhigh` 模式下，Codex 压缩上下文时可能收到 `reasoning_tokens=0` 或缺失 usage 导致 `reasoning_tokens=null`。
- 压缩响应结构可能接近 `final answer only + commentary not observed`。
- 如果按普通 high/xhigh final answer only 响应拦截，会连续返回本地拦截状态，导致上下文压缩失败。

### 根因

- 旧规则只区分 `reasoning.effort` 和响应结构，没有区分“普通回答请求”和“Codex 上下文维护请求”。
- 本机真实 analytics 样本显示 Codex 压缩链路带有请求头：
  - `x-codex-beta-features: remote_compaction_v2`
- 该请求头足以作为请求侧特征；不能把 `reasoning_tokens=0/null` 全局放行，否则会削弱 high/xhigh final answer only 的正常拦截价值。

### 处理

- 新增请求类型识别：
  - `remote_compaction_v2` / `remote_compaction` / `context_compaction` -> `request_kind=context_compaction`
- `context_compaction` 样本不参与当前拦截规则命中：
  - 不计入 `matched_current_rule`
  - 不计入 `blocked_by_gateway`
  - 不触发 `guard_retry_attempts` 内部重试
- 样本仍完整落盘和导出：
  - `request_kind`
  - `intercept_exempt_reason=context_compaction`
  - `reasoning_tokens=0/null`
  - `final_answer_only`

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `remote_compaction_v2 reasoning_tokens=0 不应被 final only 模式拦截: 502`
- 修复后：
  - `node --check .\gateway.mjs`
  - `node --check .\scripts\test-gateway-e2e.mjs`
  - `node .\scripts\test-gateway-e2e.mjs`

### 后续修正

- `x-codex-beta-features: remote_compaction_v2` 只是 Codex Desktop 的 beta feature 标记，不足以证明当前请求正在做上下文压缩。
- 真实样本显示普通 `request_kind=turn` 也会带 `remote_compaction_v2`，如果把该头直接识别成 `context_compaction`，会导致普通回答里的 `reasoning_tokens=516` 被错误豁免，既不命中规则，也不会触发 `guard_retry_attempts` 内部重试。
- 新口径：
  - 只有显式 `context_compaction` 信号才标记 `request_kind=context_compaction`
  - 只有 `context_compaction + reasoning_tokens=0` 才写 `intercept_exempt_reason=context_compaction`
  - `null`、`18`、`516/1034/1552` 等其它值不走压缩豁免，仍按当前拦截规则处理

## 2026-07-02 final answer only 实验规则普通 0 误伤风险过高

### 现象

- 用户反馈 `final_answer_only_high_xhigh` 可能出现“要么大量拦截，要么几乎不拦截”的极端表现。
- 本机样本显示普通 high/xhigh 请求里也会出现 `final_answer_only=true + reasoning_tokens=0`。
- 当前没有足够公开证据证明普通 `reasoning_tokens=0` 一定等价于降智；把 0 纳入实验硬拦截会明显提高误伤风险。

### 根因

- 旧实验规则只要求：
  - `reasoning.effort=high/xhigh`
  - `final_answer_only=true`
  - 未观察到 commentary / tool call / reasoning item
- 该规则没有区分 `reasoning_tokens=0` 与 `reasoning_tokens=null/非 0`。
- `reasoning_tokens=0` 在压缩和普通 turn 中都可能出现，单独作为硬拦截依据证据不足。

### 处理

- `final_answer_only_high_xhigh` 规则排除普通 `reasoning_tokens=0`：
  - 普通 `0 + final_answer_only + high/xhigh` 只观察落盘，不触发该实验规则。
  - `null/缺失 + final_answer_only + high/xhigh` 仍可命中。
  - 非 0 `reasoning_tokens + final_answer_only + high/xhigh` 仍可命中。
- 既有 `context_compaction + reasoning_tokens=0` 压缩豁免保持不变。
- `reasoning_tokens` 主规则不变，516/1034/1552 仍按默认主规则处理。

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `普通 high final answer only reasoning_tokens=0 应放行观察: 502`
- 修复后：
  - `node --check .\gateway.mjs`
  - `node --check .\scripts\test-gateway-e2e.mjs`
  - `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 新增 final answer only 规则样本后，模型家族精确统计需要同步

### 现象

- 为 `final_answer_only_high_xhigh` 增加高思考拦截用例后，`node .\scripts\test-gateway-e2e.mjs` 失败：
  - `gpt-5.5 家族 total_checked 统计不正确`
- 失败发生在 `model_insights.family_breakdown` 精确计数断言。

### 根因

- 新增的 high/xhigh final answer only 请求不仅验证拦截规则，也会进入既有模型一致性统计。
- 这些请求的上游声明模型与请求模型一致，因此会同时增加 `total_checked` 与 `matched`。
- 旧断言使用精确数值，不会自动吸收新增样本。

### 处理

- 保留精确断言，不改成宽松 `>=`。
- 将 `gpt-5.5` 家族统计同步到新增样本后的真实口径：
  - `total_checked = 13`
  - `matched = 12`
  - `match_ratio = 12 / 13`
- 断言失败信息补充实际值，避免后续靠猜测调整。

### 验证

- `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 reasoning 特征分析新增 helper 时不要复用既有通用函数名

### 现象

- 为 `/api/analytics/reasoning/analyze` 增加分析 Profile 解析时，新增了一个本地 helper：
  - `normalizeStringList`
- `node --check .\gateway.mjs` 直接失败：
  - `SyntaxError: Identifier 'normalizeStringList' has already been declared`

### 根因

- `gateway.mjs` 早已有全局 `normalizeStringList(values, fallback)`，用于配置归一化。
- 新增分析模块又声明了同名函数，ESM 顶层作用域不允许重复声明。

### 处理

- 将分析模块私有 helper 改名为：
  - `normalizeAnalysisStringList`
- 所有分析 Profile 和过滤条件解析统一使用新名字，避免影响旧配置归一化逻辑。

### 验证

- `node --check .\gateway.mjs`
- `node --check .\scripts\test-gateway-e2e.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 历史导入分析指定 source_paths 时不能再混入默认真实大库

### 现象

- 新增历史导入分析后，E2E 使用临时 SQLite 小库触发 `/api/analytics/imports/run`。
- 任务进度停在 `processed_sources=2/4`，已经完成测试用 CC Switch 和 Codex logs 小库，但又继续扫描默认 `%USERPROFILE%\.codex\logs_2.sqlite` 等真实大库。
- 这会让测试变慢，也会在用户只想分段导入时误扫 1GB / 2GB 级历史库。

### 根因

- `buildHistoricalImportSources()` 对每个数据源都使用“请求路径或默认路径”的写法。
- 只要某个可选 alt 路径没传，就会自动补默认真实路径。
- 这与“传入 `source_paths` 就只分析指定源”的分段导入语义冲突。

### 处理

- 增加 `hasRequestedSources = Object.keys(source_paths).length > 0`。
- 当请求体传入任意 `source_paths` 时，只收集显式指定的数据源，不再混入默认真实大库。
- 不传 `source_paths` 时，才自动发现本机默认 CC Switch、Codex logs 和 Codex sessions。

### 验证

- `node --check .\gateway.mjs`
- `node --check .\scripts\test-gateway-e2e.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 reasoning 大范围导出不应 31 天硬拒绝，应后台分段导出

### 现象

- 第一版大范围保护把 `31` 天以上 JSON / CSV 导出做成 HTTP `413` 拒绝。
- 用户明确要求大范围导出可以分段慢慢导出，要有进度条和提醒，但不能影响正常代理工作。
- 如果继续用 `413`，后续 60 天、90 天复盘都要人工拆日期，容易漏数据，也不符合“大盘离线分析”的使用方式。

### 根因

- 之前只实现了“防止 UI 卡死”的保护，没有补后台任务通道。
- 同步导出适合短时间段，但长时间段应该从交互请求里拆出去。

### 处理

- 保留 `31` 天以内同步 JSON / CSV 导出。
- `32` 天及以上改为返回 HTTP `202`，并创建后台导出任务：
  - 返回 `export_job.job_id`
  - 返回 `progress.total_days / processed_days / percent`
  - 后台按本地日期逐日读取 analytics 日文件和内存缓冲
  - 每处理一天后让出事件循环，避免长循环占住代理主链路
  - 完成后写入 `<state_root>/analytics/exports/<job_id>/reasoning-export.json|csv`
  - 新增任务状态接口和下载接口
- 管理页导出按钮改为先创建任务，再轮询进度；页面显示“可以继续正常使用 gateway”的提醒，完成后展示下载链接。

### 验证

- `node --check .\gateway.mjs`
- `git diff --check`
- `node .\scripts\test-gateway-e2e.mjs`

### 边界

- 后台任务状态当前保存在 gateway 进程内存中，进程重启后任务状态不会恢复。
- 当前不引入数据库，不打 zip；后续再补每日 rollup、明细索引和压缩包导出。
- 没有重启当前本机 `127.0.0.1:4610` 工作路由。

## 2026-07-01 reasoning analytics 缺少机器可判定激活信号，且大范围查询可能无边界深解析

### 现象

- 补完 reasoning analytics 后，文档要求用硬信号判断新进程是否真正激活。
- 但 E2E 新增断言后首先失败：
  - `status reasoning_behavior 缺少 schema_version=2`
- 这说明状态接口虽然返回了 `reasoning_behavior` 聚合数据，但缺少机器可判定字段。
- 同时，`date_from/date_to` 时间段接口和导出接口会直接读取命中范围内的日文件；如果时间段很大，后续有被大量日文件拖慢的风险。

### 根因

- `buildReasoningBehaviorSnapshotFromSamples()` 只返回业务统计，没有返回 analytics schema 和 ready 状态。
- `buildReasoningBehaviorRuntimeSnapshot()` 也没有追加运行期元信息，例如：
  - `analytics_started_at`
  - `analytics_state_root`
  - 最近 flush 状态
- 时间段查询和导出接口没有先计算日期跨度，也没有大范围降级或拒绝策略。

### 处理

- reasoning snapshot 统一补：
  - `schema_version = 2`
  - `analytics_ready = true`
- runtime metadata 补：
  - `analytics_started_at`
  - `analytics_state_root`
  - `analytics_last_flush_at`
  - `analytics_last_flush_error`
- 状态接口、独立观测接口、JSON 导出都带上这些硬信号。
- 大范围观测查询增加软降级：
  - 超过 `7` 天返回 `degraded=true`
  - `degrade_reason=date_range_too_large`
  - 不返回明细样本
- 第一版大范围导出曾增加明确拒绝：
  - 超过 `31` 天返回 HTTP `413`
  - 错误码 `reasoning_export_range_too_large`
  - 提示缩小范围或后续使用分片/压缩包导出
- 后续已升级为后台分段导出任务；详见上一条 2026-07-01 记录。

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `status reasoning_behavior 缺少 schema_version=2`
- 修复后：
  - `node --check .\gateway.mjs`
  - `git diff --check`
  - `node .\scripts\test-gateway-e2e.mjs`

### 边界

- 这次先实现硬信号和大盘查询降级边界。
- 没有引入数据库。
- 后台分段导出已在后续记录中补齐，但压缩包导出仍未实现。
- 没有重启当前本机 `127.0.0.1:4610` 工作路由。

## 2026-06-30 reasoning 行为统计 runtime 状态未初始化会让旁路请求直接 502

### 现象

- `node .\scripts\test-gateway-e2e.mjs` 最早失败在：
  - `/v1/models 透传状态异常: 502`
- `/v1/models` 不在 reasoning 检查 endpoints 内，理论上应该只是旁路透传。

### 根因

- 普通代理请求进入后会立即调用：
  - `nextGatewayRequestId(runtime.reasoningBehavior)`
- 但 `runtime` 初始化时没有挂 `reasoningBehavior: createReasoningBehaviorState()`
- 旁路请求还没发到上游，就因为本地状态为空抛错，被顶层 catch 映射成 502。

### 处理

- 在运行时初始化对象中补齐：
  - `reasoningBehavior: createReasoningBehaviorState()`
- 这样所有普通代理请求进入时都能分配 `gateway_request_id`，旁路、检查、失败、重试都共享同一套采集状态。

### 验证

- `node --check .\gateway.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-06-30 inspected 主链 handler 如果不落样本，reasoning 大盘会只剩旁路和失败样本

### 现象

- UI 大盘补齐后，E2E 继续失败：
  - `reasoning 行为样本总数不正确`
- 状态接口里 `reasoning_behavior.summary.total_samples` 明显偏低，只看到旁路、拒绝或失败样本。

### 根因

- `proxyRequest()` 已经为每次 attempt 创建了 `reasoningSample` 和 `structureAccumulator`
- 但 `handleNonStreaming()` / `handleStreaming()` 没有接收和使用这两个对象
- handler 内部返回 `passed`、`observe_only`、`blocked`、`internal_retry` 时没有调用 `finalizeReasoningBehaviorSample()` 和 `recordReasoningBehaviorSample()`
- 流式分支也没有记录首 chunk、首内容、最终 chunk、usage 与结构信号。

### 处理

- `handleNonStreaming()`：
  - 补 usage、响应结构信号
  - 按 `passed` / `observe_only` / `blocked` / `internal_retry` 落样本
- `handleStreaming()`：
  - 补 `first_stream_chunk_at`、`first_content_at`、`final_chunk_at`
  - 累计 SSE payload 的 usage、模型信号和结构信号
  - 按 `passed` / `observe_only` / `blocked` / `internal_retry` / `disconnect` / `upstream_stream_terminated` 落样本
- `upstream_fetch_failed` 样本统一记录 `client_http_status = 502`
- CSV 导出补充流式时序、结构信号、内部重试与 stream termination 字段。

### 验证

- `node --check .\gateway.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-06-29 reasoning 统计如果只记“有正常上游响应的请求”，后面很多关键字段会永远缺失

### 现象

- 用户新要求变成：
  - 每一次请求都尽量详细
  - 连当前被拦截的请求也要详细落盘
  - 后续要区分 `gpt-5.4` / `gpt-5.5` 和 `reasoning.effort`
- 旧实现虽然已经有 reasoning 样本，但主要还是围绕“已检查响应”展开：
  - 正常透传和命中规则请求比较完整
  - 但像旁路透传、上游 `fetch failed`、请求体超限这类请求，要么没进样本，要么字段很薄

### 根因

- reasoning 样本之前是围绕 `upstreamResponse` 和检查链路补的
- 请求在这些更早的阶段失败时：
  - 还没进入 `handleNonStreaming()` / `handleStreaming()`
  - 甚至还没完成上游连接
- 结果会导致“统计总数看起来不少，但关键失败请求没有事实样本”

### 处理

- 把 reasoning 样本入口前移到 `proxyRequest()`：
  - 一开始就分配 `gateway_request_id`
  - 一开始就创建请求摘要 accumulator
- 落盘范围扩成：
  - 正常透传
  - observe_only
  - blocked
  - internal_retry
  - bypassed
  - upstream_fetch_failed
  - request_rejected
- 每条样本尽量保留：
  - 请求 headers 脱敏副本
  - 请求体大小 / sha256 / 摘要
  - 请求结构摘要
  - 上游状态 / 客户端状态
  - 失败摘要 / 响应摘要
  - `gpt-5.4` / `gpt-5.5` family
  - `reasoning.effort`
- 聚合新增：
  - `by_model_family`
  - `by_reasoning_effort`
  - `by_model_family_and_effort`

### 验证

- `node .\scripts\test-gateway-e2e.mjs`
  - reasoning analytics 状态接口新增 family / effort / family+effort 分桶断言
  - reasoning JSON 导出新增请求摘要、失败摘要、客户端状态断言
  - reasoning 日文件新增 `schema_version = 2` 和失败样本断言
- `node .\scripts\test-install-restore.mjs`
  - 安装/恢复回归继续通过

## 2026-06-29 reasoning 统计新增模型/思考等级样本后，模型一致性旧断言需要同步调整

### 现象

- 为了让 reasoning analytics 真正产出 `gpt-5.4` / `gpt-5.5` 与 `reasoning.effort` 分桶
- E2E 新增了几条带不同模型和 effort 的真实请求
- 结果 `model_insights.family_breakdown` 的旧精确断言直接失败
  - 例如 `gpt-5.4 total_checked` 从旧值涨到了新值

### 根因

- 这些新增请求不只是 reasoning analytics 的样本
- 同时也会进入原有 `finalizeModelInsights()` 统计
- 所以 `family_breakdown` 的精确计数必须跟着真实新增样本一起调整

### 处理

- 保留精确断言，不改成模糊的 `>=`
- 先打印实际 `family_breakdown` 真值确认影响面
- 再把 E2E 中这组旧计数同步更新到新口径

### 验证

- `node .\scripts\test-gateway-e2e.mjs` 通过

## 2026-06-29 reasoning 行为统计导出不能只读日文件，必须合并内存缓冲样本

### 现象

- 新增 reasoning 行为统计后：
  - 状态接口和管理页已经能看到最新样本
  - 但 `GET /__codex_retry_gateway/api/analytics/reasoning/export?format=json` 导出的 `samples` 为空或显著偏少

### 根因

- 运行中样本先进入内存 recent window 和 daily buffer
- 日文件写入是节流 flush，不保证每次请求后立刻落盘
- 导出接口如果只读取 `analytics/reasoning-behavior-YYYY-MM-DD.json`，会漏掉尚未 flush 的最新样本

### 处理

- 导出读取逻辑改成：
  - 先读日期范围内的日文件
  - 再合并当前内存里的 `reasoning_behavior_daily_buffers`
  - 最后统一排序并重新计算导出统计

### 验证

- `node .\scripts\test-gateway-e2e.mjs`
  - 新增 reasoning JSON 导出包含样本断言
  - 新增 reasoning CSV 导出包含表头断言

## 2026-06-29 主动探针测试夹具必须与 stateRoot / auth 查找规则对齐

### 现象

- 新增 reasoning 行为统计后，主动探针相关 E2E 超时
- 状态接口显示：
  - `active_probe.total_runs = 1`
  - 但 `recent_samples` 大量是 `401`
  - `error_excerpt = missing_authorization | authorization header required`

### 根因

- 网关读取鉴权时会按两条路径查找：
  - `path.dirname(codex_config_path)/auth.json`
  - `runtime.paths.stateRoot/auth.json`
- 不同测试场景的 `config.json` 布局不同：
  - 有的是 `<root>/config/config.json`
  - 有的是 `<root>/probe-runtime/config.json`
- 测试夹具若把 `state.json` / `auth.json` 写到错误层级，主动探针就会稳定落到 `401 indeterminate`

### 处理

- 保持 `buildRuntimePaths()` 规则不变：
  - 目录名为 `config` 时，`stateRoot = 上一级`
  - 其他情况，`stateRoot = config.json 所在目录`
- E2E 测试夹具按对应场景写入 `state.json` / `auth.json`
- 对关键 probe 场景额外补一份 `auth.json` 到 `codex_config_path` 同目录，避免目录布局差异再次误伤

### 验证

- `node .\scripts\test-gateway-e2e.mjs`
  - 主动探针长上下文 / warning / 缺鉴权场景全部恢复通过

## 2026-06-29 Issue #6：旧配置缺字段导致 PowerShell StrictMode 安装失败

### 现象

- 用户更新后执行：
  - `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1`
- 报错：
  - `The property 'intercept_streaming' cannot be found on this object`
  - 位置指向 `scripts\install-for-current-provider.ps1`

### 根因

- 旧版 `config.json` 没有 `intercept_streaming` / `intercept_non_streaming` / `guard_retry_attempts` 等新增字段
- PowerShell 脚本启用了 `Set-StrictMode -Version Latest`
- 在 StrictMode 下直接访问 `$existingGatewayConfig.intercept_streaming`，缺字段会抛异常，不能像普通 PowerShell 那样默认为 `$null`

### 处理

- `install-for-current-provider.ps1` 新增本地 helper：
  - `Get-OptionalPropertyValue`
- 所有可选旧配置字段统一通过 `PSObject.Properties[...]` 安全读取
- 缺失字段回落默认值：
  - `intercept_streaming = true`
  - `intercept_non_streaming = true`
  - `guard_retry_attempts = 3`
  - 其他字段沿用既有默认
- `scripts/test-install-restore.mjs` 增加旧配置缺字段后再次执行安装脚本的回归覆盖

### 跨平台补充

- 本轮专门重跑 Windows 和 Unix 入口测试
- 发现当前 worktree 缺 `.gitattributes`，导致 `.sh` 入口再次变成 CRLF，Bash 报：
  - `set: pipefail\r: invalid option name`
- 新增 `.gitattributes`：
  - `*.sh text eol=lf`
- 将现有 `.sh` 入口统一转为 LF

### 验证

- `node .\scripts\test-install-restore.mjs` 通过
- `node .\scripts\test-launch-ui.mjs` 通过
- `node .\scripts\test-launch-ui-unix.mjs` 通过

## 2026-06-29 命中拦截规则后不能继续把失败状态码暴露给 Codex

### 现象

- 规则拦截此前会向 Codex 返回本地 `502`
- Codex 遇到失败状态后会自动 `Reconnecting...`
- 连续重连达到上限后，会话可能断开
- 实测 `409` 和 `422` 也会触发 Codex 自动重连，不能作为最终拦截收口状态码

### 根因

- 网关把“本地规则拦截”伪装成 HTTP 失败状态返回给 Codex
- Codex 无法区分这是本地规则命中，还是上游真实故障
- 早期为了快速上线依赖 Codex 自身重连，导致命中规则时有断会话风险

### 处理

- 新增 `guard_retry_attempts`
  - 默认 `3`
  - 必须是大于等于 `0` 的整数
  - `0` 表示不做网关内部规则重试
  - 无上限，管理页保存后立即生效
- 仅当响应命中当前拦截规则且会被实际拦截时，网关内部重新请求上游
- 上游真实 HTTP `429` / `502` 等错误如果没有命中规则，继续原样透传给 Codex
- `fetch failed` 仍按既有上游连接失败逻辑处理，本轮不改变其语义
- 内部重试统计沿用现有 UI 口径：
  - 每次上游尝试计入代理请求总数
  - 每次被检查的响应计入被检查响应总数
  - 命中规则计入当前规则命中总数
  - 被吞掉重试或最终拦截计入实际拦截总数
- 命中日志动作：
  - `action=internal_retry remaining=N`：本次命中被网关吞掉，并继续内部重试，没有暴露给 Codex
  - `action=return_status_502`：重试次数为 `0` 或已达到上限，本次才真正向 Codex 返回拦截状态
  - `action=observe_only`：当前类型命中但配置为只观察不拦截

### 验证

- `node .\scripts\test-gateway-e2e.mjs`：
  - 覆盖非流式 `516 -> 128` 内部重试恢复为 `200`
  - 覆盖流式 strict `516 -> 128` 内部重试恢复为正常 SSE
  - 覆盖连续 `516 -> 516` 超过上限后才返回本地拦截状态
  - 覆盖上游真实 `429` 不触发规则内部重试并原样透传
- `node .\scripts\test-install-restore.mjs`：
  - 覆盖新装默认 `guard_retry_attempts = 3`
  - 覆盖旧配置迁移补默认值
  - 覆盖保存配置持久化 `guard_retry_attempts`

## 2026-06-28 长上下文主动探针从词数近似升级为 token 预算硬探针

### 现象

- 旧版 `long_context` 只按 `target_word_count` 构造重复文本
- 虽然能大致撞进 `>400K` 区间，但不能证明请求真的按目标模型口径到达了目标 token 预算

### 根因

- 上游当前不兼容官方 `responses/input_tokens` 计数接口
- 旧实现只能用词数近似，证据强度不够

### 处理

- 长上下文探针配置改为 `long_context.target_input_tokens`
- 探针先发送小样本校准请求，读取同一目标模型返回的 `usage.input_tokens`
- 再按真实返回口径估算并构造预算请求
- 样本与日志里落盘：
  - `target_input_tokens`
  - `observed_input_tokens`
  - `estimated_input_tokens`
  - `budget_source=response_usage`

### 验证

- 仓库回归：
  - `node .\scripts\test-gateway-e2e.mjs` 通过
- UI 文案回归：
  - “模型家族一致性” 改为 “模型家族一致性（被动探针）”

## 2026-06-28 主动探针图片输入误报 502 / transport_error

### 现象

- 主动探针里的 `image_input` 在真实上游上持续返回：
  - `502`
  - `transport_error` 或 `indeterminate`
- 但同一时段：
  - `long_context` 可以 `200 pass`
  - 用户手工实测 `gpt-5.4` / `gpt-5.5` 图片能力正常

### 根因

- 探针图片使用的是 `data:image/svg+xml;base64,...`
- 当前兼容链路对 `SVG data URL` 处理不稳定，真实现象会表现为上游拒绝、超时或被转写成 `502`
- 官方文档列出的常见视觉输入类型是 `png / jpg / gif / webp`，不包含 `svg`

### 处理

- 将主动探针内置图片从 `SVG data URL` 改为光栅 `PNG data URL`
- 保持探针请求结构不变，只替换图片 MIME 类型与内容
- 在 E2E 假上游里增加一条约束：
  - 若图片探针仍发送 `data:image/svg+xml`，则模拟上游异常
  - 这样可以防止后续回归把 `SVG` 又带回来

### 验证

- 仓库回归：
  - `node .\scripts\test-gateway-e2e.mjs` 通过
- 本机真实验证：
  - `gpt-5.5 image_input`：`200 pass`，证据为 `A`
  - `gpt-5.4 image_input`：`200 pass`，证据为 `A`

## 2026-06-26 独立 Codex Retry Gateway

### 设计边界

- 只解决 Codex 已可访问上游时的 `reasoning_tokens = 516` 重试问题
- 不替代 `cc-switch` 的协议路由转换
- 流式场景默认策略是：
  - 先缓存上游流
  - 一旦检测到命中 `516`
  - 统一返回 `502`

### 当前已知限制

- 如果上游只支持 Chat Completions、而 Codex 当前链路需要 Responses 协议转换，这个项目不处理该转换
- 这个项目依赖 Codex / Codex Desktop 自身的自动重试能力

### 本次已确认并修复的问题

1. `gateway.mjs` 非流式透传发头顺序错误
   - 现象：`ERR_HTTP_HEADERS_SENT`
   - 根因：`writeHead()` 在 `copyHeadersToClient()` 之前调用
   - 结果：正常 `128` 响应也会被打断

2. PowerShell 脚本在 `powershell.exe` 下的解析兼容性
   - 现象：脚本乱码并伴随解析异常
   - 根因：新脚本初版包含中文运行时字符串，且 `param(...)` 不在文件最前
   - 处理：运行时输出改成 ASCII，并把 `param(...)` 提前到文件顶部

3. `stop-gateway.ps1` 与 PowerShell 内置只读变量 `$PID` 冲突
   - 现象：安装脚本在重启 gateway 时失败
   - 处理：改用 `$gatewayPid`

4. `start-gateway.ps1` 启动 Node 时路径带空格
   - 现象：gateway 进程启动后立刻退出
   - 根因：`Start-Process` 参数未显式带引号
   - 处理：改为手工拼带引号的 `ArgumentList`

5. PowerShell 单元素数组落盘时被拆成标量
   - 现象：`reasoning_equals` 被写成 `516`，不是 `[516]`
   - 处理：在公共归一化函数里强制返回数组

6. 旧脏配置迁移后出现嵌套/拼接 endpoints
   - 现象：`endpoints` 可能变成嵌套数组，或出现一条用空格拼接的脏字符串
   - 处理：安装脚本合并 endpoints 时做递归拍平和空白拆分

7. 真实 Codex 客户端请求路径不是 `/v1/responses`
   - 现象：`codex exec` 在 gateway 关闭时真实报错地址是 `http://127.0.0.1:4610/responses`
   - 结论：默认配置必须同时覆盖：
     - `/responses`
     - `/chat/completions`
     - `/v1/responses`
     - `/v1/chat/completions`

8. UI 恢复动作最初采用“子进程拉起 restore 脚本”方案
   - 现象：浏览器拿到 `202`，但临时 `config.toml`、`state.json`、`gateway.pid` 都没有变化
   - 根因：恢复动作通过 detached 子进程接力时，链路可靠性不足，实际没有把恢复流程真正执行完
   - 处理：改为当前 gateway 进程直接复制备份、清理状态并自我退出

9. 新增内嵌 UI 管理页
   - 入口：`/__codex_retry_gateway/ui`
   - 能力：
     - 查看当前接管状态
     - 热更新 `reasoning_equals`
     - 热更新 `endpoints`
     - 热更新 `non_stream_status_code`
     - 开关 `log_match`
     - 一键恢复 Codex 原设置

10. 用户不接受 `cc-switch` 路由模式，且不希望手工改设置
   - 现象：仅有安装脚本和 UI 还不够，首次接管、再次拉起、重新打开 UI 仍需要手工串命令
   - 处理：新增 `launch-ui.ps1`
   - 结果：
     - 首次运行自动安装并打开 UI
     - 再次运行自动复用 `state.json + config.json` 并重启 gateway
     - 平时规则调整和恢复统一回到 UI 内完成

11. UI 需要动态显示实时日志、`516` 次数和占比
   - 现象：原 UI 只能改配置，看不到运行中的命中趋势
   - 处理：
     - 在 `gateway.mjs` 内增加运行期统计
     - 增加日志接口
     - UI 轮询显示“被检查响应总数 / 516 命中次数 / 516 占比 / 实时日志”
   - 统计口径：
     - 按本次 gateway 启动以来累计
     - `516` 占比 = `reasoning_tokens = 516` 的响应次数 / 被检查响应总数

12. macOS / Linux 不能直接使用现有 PowerShell 管理脚本
   - 现象：`launch-ui.ps1`、`restore-codex-config.ps1` 等入口绑定了 PowerShell 和 Windows 进程控制
   - 处理：
     - 新增跨平台 `node` 管理核心
     - 新增 `.sh` 包装入口：
       - `launch-ui.sh`
       - `restore-codex-config.sh`
       - `install-for-current-provider.sh`
       - `start-gateway.sh`
       - `stop-gateway.sh`
   - 结果：
     - Windows 继续走 `.ps1`
     - macOS / Linux 直接走 `.sh`
     - UI、状态文件、gateway 主逻辑保持同一套

13. Windows 主机上模拟 Unix shell 入口时存在路径与 Node 版本兼容问题
   - 现象：
     - Bash 入口最初找不到脚本路径
     - Bash 默认 `node` 版本过老，不支持现代语法
     - `node.exe` 需要 Windows 路径，而 shell 侧是 POSIX 路径
   - 处理：
     - 测试改成相对 POSIX 路径执行 `.sh`
     - `.sh` 优先选择 `node.exe`
     - 在 WSL / Bash 场景下把路径参数转换回 Windows 路径后再交给 `node.exe`

14. 上游流式连接中途终止时被误记为网关错误，首次瞬断也缺少最小重试
   - 现象：
     - 日志出现：
       - `TypeError: terminated`
       - `TypeError: fetch failed`
     - 其中一部分来自上游 SSE 中途断流，另一部分来自上游首次连接瞬时失败
   - 根因：
     - `handleStreaming()` 直接把 `reader.read()` 抛出的 `AbortError` / `TypeError: terminated` 冒到统一错误处理
     - `proxyRequest()` 对上游 `fetch()` 没有做一次轻量重试，首个瞬断会直接返回 `502`
   - 处理：
     - 新增预期流终止识别：
       - `AbortError`
       - `TypeError: terminated`
     - 这两类在流式处理中按“连接已结束”收口，不再记 `[error]`
     - 新增上游 `fetch failed` 的一次自动重试
     - 新增严格 `502` 流式模式：
       - 默认不再抢先透传 `200` 头和首个 chunk
       - 先缓存流，再根据 `reasoning_tokens` 决定透传或返回 `502`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增 `/responses` 流式覆盖
       - 新增“上游半路断流不刷 error 日志”断言
       - 新增“首次 fetch failed 后第二次成功恢复”断言
       - 新增“流式 `516` 统一返回 `502`，不再先透传半截 chunk”断言
     - `scripts/test-install-restore.mjs` 继续通过

15. 管理页刷新会把代理请求总数加一
   - 现象：
     - 打开或刷新 `__codex_retry_gateway/ui` 后，页面里的“代理请求总数”会额外增加
   - 根因：
     - 浏览器自动请求 `/favicon.ico`
     - 网关未把该请求识别为管理页附属资源，落入普通代理路径并计入 `total_proxy_request_count`
   - 处理：
     - 在管理请求分支提前处理 `/favicon.ico`
     - 直接返回 `204`
     - 不再进入普通代理计数
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“管理页刷新相关请求不应增加代理请求总数”断言

16. 新增模型家族一致性检测与单请求高风险漂移检测
   - 目标：
     - 本地模型为 `gpt-5.4` / `gpt-5.5` 时，检查链路声明和行为是否符合 `1M` 家族特征
   - 处理：
     - 新增本地请求模型、上游声明模型、流式声明模型统计
     - 新增声明一致率与最近可疑样本
     - 新增 `400K` 家族异常检测
     - 新增单请求模型漂移检测
     - 新增疑似请求内重建/重试检测
   - 证据保留：
     - 每条可疑样本保留：
       - 本地期望模型
       - 上游声明模型
       - 流式声明模型
       - 首个观测模型
       - 最后观测模型
       - 模型集合
       - 指纹集合
   - 边界：
     - 声明一致不等于已证明真实运行一致
     - `400K` 家族异常只表示行为上疑似不符合 `1M` 家族
     - 单请求模型漂移与疑似请求内重建/重试都按高风险展示
     - 无法直接确认 provider 内部缓存重建
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增 `gpt-5.4` / `gpt-5.5` 一致声明断言
       - 新增 `mini` 声明不一致断言
       - 新增 `400000 context window` 异常断言
       - 新增单请求模型漂移断言
       - 新增疑似请求内重建/重试断言

17. 管理页内联脚本语法错误会导致整页状态全部不灌值
   - 现象：
     - `运行状态`、`拦截规则`、`模型家族一致性` 都显示为初始空值
     - 浏览器控制台报：
       - `SyntaxError: Invalid or unexpected token`
   - 根因：
     - 新增“日志证据”展示时，内联脚本里的 `join('\n')` 被模板 HTML 吃成了真实换行
     - 最终生成的 `<script>` 语法非法，初始化逻辑完全没有执行
   - 处理：
     - 改成 `join('\\n')`
     - 在 `scripts/test-gateway-e2e.mjs` 里新增“管理页内联脚本可被 `vm.Script` 解析”断言

18. Unix `.sh` 入口在 Bash 下因为 CRLF 行尾直接失败
   - 现象：
     - `scripts/test-launch-ui-unix.mjs` 失败
     - Bash 报错：
       - `set: pipefail\r: invalid option name`
   - 根因：
     - `.sh` 文件被写成了 `CRLF`
     - Bash 把 `\r` 当成命令内容的一部分
   - 处理：
     - 把所有 `.sh` 入口统一转成 `LF`
     - 新增仓库级 `.gitattributes`
       - `*.sh text eol=lf`

19. 最近可疑样本里的“查看日志”会在自动刷新后瞬间收起
   - 现象：
     - 点开“日志证据”里的 `查看 N 条`
     - 约 2 秒一次的页面轮询后会自动收起
   - 根因：
     - `renderSuspiciousSamples()` 每次轮询都会整体重写 `tbody.innerHTML`
     - `<details>` 的展开态属于 DOM 本地状态，节点被重建后自然丢失
   - 处理：
     - 给最近可疑样本增加签名比对
     - 样本数据没变化时不重绘
     - 样本数据有变化时保留用户已展开的 `data-sample-key` 状态并恢复
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“最近可疑样本未变化时不应重绘日志证据 DOM”断言
       - 新增“最近可疑样本刷新后已展开的日志证据不应自动收起”断言

20. 正常拦截流式 `516` 会被误报成 `single_request_rebuild_suspected`
   - 现象：
     - `/responses` 流式命中 `reasoning_tokens = 516` 被本地严格 `502` 正常拦截后
     - 管理页仍可能出现：
       - `single_request_rebuild_suspected`
   - 根因：
     - 流式 SSE 事件里的顶层 `id` 可能只是事件 id，不是响应 `response.id`
     - 监控层此前把流式 payload 顶层 `id` 也记进 `observedResponseIds`
     - 同一请求里多个事件 id 被误当成多个响应 id，触发“疑似请求内重建/重试”
   - 处理：
     - `extractPayloadResponseId()` 改为仅在非流式场景允许回退到 payload 顶层 `id`
     - 流式场景只认 `payload.response.id`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“带事件 id 的 516 流式请求未返回 502”覆盖
       - 新增“正常拦截 516 不应计入疑似请求内重建/重试”断言
       - 新增“正常拦截 516 不应生成 single_request_rebuild_suspected 可疑样本”断言

21. 管理页实时日志时间显示与本机时间不一致，且代理请求总数与被检查响应总数差值缺少解释
   - 现象：
     - “实时日志”直接显示原始 UTC 时间串
     - `代理请求总数` 与 `被检查响应总数` 存在差值时，页面看不出是哪些请求造成的
   - 根因：
     - `renderLogs()` 直接输出 `entry.at`，没有复用 `formatTimestamp()`
     - `total_proxy_request_count` 统计的是所有进入普通代理分支的请求
     - `inspected_response_count` 只统计真正进入检查逻辑的响应
     - 像 `/v1/models` 这类未纳入 `endpoints` 检查范围的透传请求会进入代理总数，但不会进入被检查总数
   - 处理：
     - `renderLogs()` 改为统一走 `formatTimestamp()`
     - 新增运行期统计：
       - `bypassed_proxy_request_count`
       - `bypassed_proxy_path_counts`
       - `failed_proxy_request_count`
     - 在“运行状态”脚注里明确展示：
       - 总数计算口径
       - 当前差值
       - 未纳入检查的透传路径分布
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“实时日志应显示与系统时间一致的本地时间”断言
       - 新增“运行状态脚注应提示未纳入检查的透传路径”断言
       - 新增“代理请求总数与被检查响应总数的差值应能由透传请求和失败请求解释”断言

22. 管理页差值在慢请求进行中会继续放大，但页面之前没有把“进行中的代理请求”单独解释出来
   - 现象：
     - `代理请求总数` 与 `被检查响应总数` 的差值不只出现在透传或失败请求场景
     - 当普通代理请求仍在执行中时，差值会临时增大，但页面之前无法说明来源
   - 根因：
     - 缺少运行期 `active` 统计
     - `proxyRequest()` 也没有把普通代理请求生命周期包进开始/结束计数
   - 处理：
     - 新增运行期统计：
       - `active_proxy_request_count`
       - `active_proxy_path_counts`
     - 在普通代理请求进入后立刻记 `active start`
     - 无论成功、旁路、流式、非流式还是失败，都在 `finally` 里记 `active end`
     - “运行状态”脚注改成：
       - `代理请求总数 = 被检查响应总数 + 未纳入检查的透传请求 + 失败请求 + 进行中的代理请求`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“代理请求进行中时应记录 active_proxy_request_count”断言
       - 新增“代理请求进行中时应记录 active_proxy_path_counts”断言
       - 新增“代理请求结束后 active_proxy_request_count 应回到 0”断言

23. 声明一致率把 `unknown` 也算进分母，导致百分比与“不一致次数 / 可疑样本”口径互相打架
   - 现象：
     - 管理页里“声明一致率”可能不是 `100%`
     - 但“声明不一致次数”仍然是 `0`
     - 最近可疑样本也没有 `model_family_mismatch`
   - 根因：
     - 一致率此前按：
       - `matched / total_checked`
     - 其中 `unknown` 表示本次没有拿到可比对的上游声明，它不该被计入“不一致”，却被错误计入了一致率分母
   - 处理：
     - 一致率改为只按已声明样本计算：
       - `matched / (matched + mismatched)`
     - `unknown` 继续单独保留，但不再拉低一致率
     - 管理页文案补充“未声明样本不计入分母”
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“声明一致率应只按已声明样本计算”断言
       - 新增 `gpt-5.4` / `gpt-5.5` 家族一致率排除 `unknown` 断言

24. 网关重启后管理页会把上一次会话的旧日志继续留在页面里，导致“实时日志时间仍不对”
   - 现象：
     - 网关已重启、`started_at` 已变成新会话
     - 但“实时日志”区域仍可能保留上一轮会话里的旧文本
     - `logsMeta` 会显示新的日志总数，`logsOutput` 却还是旧内容
   - 根因：
     - 管理页日志轮询依赖 `since_seq`
     - 网关重启后，新的日志序号会从小值重新开始
     - 页面若继续沿用旧的 `lastLogSeq` 做增量请求，会拿不到完整新日志
     - 旧页面内容因此不会被替换
   - 处理：
     - 页面保存上一轮 `metrics.started_at`
     - 检测到 `started_at` 变化后，立即清空增量游标并全量重拉日志
     - 若增量响应里的 `latest_seq` 小于当前游标，也自动回退为全量重拉
     - 管理页 HTML 与管理接口统一补 `cache-control: no-store`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“网关重启后实时日志应重新全量加载并显示本地时间”断言
       - 新增“网关重启后不应继续保留上一次会话的旧日志”断言
       - 新增“检测到网关重启后应全量重拉日志”断言

25. 新增主动探针运行层，并与普通代理统计完全隔离
   - 目标：
     - 在不干扰 `proxyRequest()` 主链路的前提下，低频主动验证 `gpt-5.4` / `gpt-5.5` 声明契约
   - 处理：
     - 在 `gateway.mjs` 内新增 `active_probe` 配置和独立 `probeMonitor`
     - 新增主动探针状态快照 `active_probe`
     - 新增低频定时调度，不进入普通代理请求统计
   - 当前范围：
     - 长上下文硬契约探针
     - `gpt-5.5` 图片输入硬契约探针
     - 响应结构辅助探针
     - 身份一致性辅助探针
     - 训练截止日期 / 知识表现辅助探针
   - 边界：
     - 只做声明证伪，不做真实底层模型归因
     - 辅助探针默认只产出 `warning`
     - `transport_error` 不计入违约
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增 probe-only gateway 的 `violation` 断言
       - 新增 probe-only gateway 的 `warning` 断言
       - 新增“主动探针不应污染普通代理统计”断言

26. 管理页新增“主动探针”面板，并展示独立样本与日志证据
   - 现象：
     - 之前状态接口已有 `active_probe`，但管理页没有对应展示区域
   - 处理：
     - 新增主动探针概览卡片：
       - 状态
       - 最近目标模型
       - 最近一次运行
       - 通过 / warning / 违约 / transport error 次数
     - 新增最近主动探针样本表与日志证据
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“主动探针状态未正确展示”相关 UI 断言
     - `scripts/test-install-restore.mjs`
       - 新增管理页包含“主动探针”与状态接口暴露 `active_probe` 断言

27. 管理页模板字符串里直接写反引号文案会让 gateway 启动即崩
   - 现象：
     - 新增“主动探针”说明文案后，`/__codex_retry_gateway/health` 超时
     - `node --check gateway.mjs` 报：
       - `SyntaxError: Unexpected identifier 'warning'`
   - 根因：
     - 管理页 HTML 本身位于 JS 模板字符串中
     - 文案里直接写了反引号包裹的 `warning` / `violation` / `transport_error`
     - 导致模板字符串被提前截断
   - 处理：
     - 把该段文案改成普通文本，不再在模板字符串里直接嵌反引号
   - 验证：
     - `node --check .\\gateway.mjs`
     - `node .\\scripts\\test-gateway-e2e.mjs`

28. 真实上游的长上下文主动探针使用大量唯一编号词，会把请求体打得过碎，导致探针极慢甚至先拿到 `502`
   - 现象：
     - 假上游 E2E 全绿
     - 但真实 `ai.input.im` 上，`gpt-5.4` 长上下文探针可能耗时接近 100 秒，甚至返回 `502`
     - 同一条探针改成高密度重复词后，可在几秒内正常返回 `200`
   - 根因：
     - 旧版 `buildLongContextProbeText()` 生成的是 `w000001`、`w000002` 这类大量唯一词
     - 真实上游在分词/前置服务处理这种超高基数输入时，负担远大于“相同 token 重复”的正常长上下文场景
     - 结果把本应用来验证 400K/900K 契约的探针，先打成了“上游服务暂时不可用”
   - 处理：
     - 长上下文探针改为高密度重复 `a` token
     - 仍保持总量超过 400K 级别，但避免因为输入构造方式本身制造伪 `502`
   - 验证：
     - `node .\\scripts\\test-gateway-e2e.mjs`
     - 真实本机路由 `POST /__codex_retry_gateway/api/probe/run`
       - `gpt-5.4 long_context` 从慢速 `502` 变为快速 `200 pass`

29. 主动探针样本之前只保留了 `start` 日志，且 `401/502` 这类上游错误摘要没有落进样本
   - 现象：
     - 管理页“最近主动探针样本”里的“查看”经常只能看到开始日志
     - `401`、`502 upstream_error` 等真实证据没有保留下来
     - `现在探测一次` 还会一直等待整轮探针跑完，真实上游慢时很像按钮卡死
   - 根因：
     - `collectProbeEvidenceLogs()` 在结果日志写入前就被调用
     - `error_excerpt` 只记录 `requestError`，不会从 HTTP 错误响应体提取摘要
     - `/api/probe/run` 同步等待 `safeRunActiveProbeOnce()` 全部完成后才返回
   - 处理：
     - 为主动探针样本补充：
       - `finish ... status=... result=... confidence=...`
       - `detail=...` 错误摘要
     - `error_excerpt` 改为优先保留响应体里的 `error.type/code/message` 或文本摘要
     - `/api/probe/run` 改为后台启动探针，立即返回 `202`
   - 验证：
     - `node .\\scripts\\test-gateway-e2e.mjs`
     - `powershell -ExecutionPolicy Bypass -File .\\scripts\\test-install-restore.ps1`
     - 真实本机路由状态接口：
      - `image_input` 样本可见 `upstream_error | Upstream access forbidden, please contact administrator`
      - `gpt-5.5 long_context` 样本可见 `upstream_error | Upstream service temporarily unavailable`

30. 流式 / 非流式拦截目标拆分后，命中统计不能等同于实际拦截统计
   - 现象：
     - 用户需要三种模式：
       - 仅拦流式
       - 仅拦非流式
       - 流式 + 非流式都拦
     - 如果只用旧的 `matched_response_count`，页面无法区分“命中了但当前配置只观察”和“命中了并实际拦截”
   - 根因：
     - 旧配置只有 `stream_action` 与 `non_stream_status_code`
     - 旧统计只有规则命中总数，没有按流式 / 非流式拆分，也没有 blocked 统计
     - 非流式命中被拦截时如果提前返回，模型一致性收口会漏掉这批响应
   - 处理：
     - 新增配置：
       - `intercept_streaming`
       - `intercept_non_streaming`
     - 默认双开，保持旧行为兼容
     - 后端和管理页都禁止两个开关同时关闭
     - 新增统计：
       - `matched_streaming_count`
       - `matched_non_streaming_count`
       - `blocked_response_count`
       - `blocked_streaming_count`
       - `blocked_non_streaming_count`
     - `matched_response_count` 继续表示规则命中次数，不改成实际拦截次数
     - 命中但未拦截时日志写 `action=observe_only`
     - 非流式命中无论拦截还是透传，都进入 `finalizeModelInsights()`
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
     - `node .\scripts\test-install-restore.mjs`
     - `node --check .\gateway.mjs`
     - `git diff --check`

31. 上游 API 不可用时不应刷网关内部错误堆栈
   - 现象：
     - 日志反复出现：
       - `[retry] upstream fetch failed attempt=1 ...`
       - `[error] TypeError: fetch failed`
     - 用户确认这类报错来自上游 API 异常，不是 gateway 自身逻辑崩溃
   - 根因：
     - 统一 catch 把重试后仍失败的上游 `fetch failed` 当成普通 gateway 内部错误记录
     - 结果日志里出现大段堆栈，容易误判为本地网关问题
   - 处理：
     - 保留一次轻量重试
     - 重试后仍失败时继续返回 `502`
     - 响应错误类型改为：
       - `type=upstream_error`
       - `code=upstream_fetch_failed`
     - 日志改为摘要：
       - `[upstream-error] fetch failed after retry path=... message=fetch failed`
     - 其他未知错误仍继续记录 `[error]` 堆栈
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
       - 新增连续上游 fetch failed 返回 `upstream_error` 断言
       - 新增日志不包含 `[error] TypeError: fetch failed` 断言

32. 管理页运行状态移除旧 516 专属卡片，改为实际拦截口径
   - 现象：
     - 用户希望删除 `516 命中次数`
     - `当前规则命中总数` 放到原 `516 命中次数` 位置
     - `516 占比` 改为 `实际拦截占比`
     - `实际拦截总数` 放到原 `516 占比` 位置
   - 根因：
     - 拦截目标拆成流式 / 非流式后，`516` 专属统计不再是管理页最核心口径
     - 用户真正关心的是当前规则命中、实际拦截总数和实际拦截占比
   - 处理：
     - 管理页移除 `516 命中次数` 与 `516 占比` 卡片
     - 运行状态卡片顺序调整为：
       - 当前规则命中总数
       - 实际拦截总数
       - 实际拦截占比
     - `实际拦截占比 = blocked_response_count / inspected_response_count`
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
     - `node .\scripts\test-install-restore.mjs`

33. 管理页运行状态脚注会把大量透传路径完整展开，导致 UI 爆长
   - 现象：
     - 当 gateway 代理真实前端站点时
     - `运行状态` 脚注会把 `/assets/*`、`/login`、`/logo.png`、`/api/v1/settings/public` 等透传路径全部平铺出来
     - 整块说明文字会被撑得很长，阅读体验很差
   - 根因：
     - 管理页脚注里的 `formatPathCounts()` 直接把所有路径计数 `join('，')`
     - 没有做条目数收敛或摘要化
   - 处理：
     - 保留路径分布提示，但只展示按次数排序后的前 `3` 项
     - 剩余条目统一收敛成 `其余 N 项`
     - 进行中的代理请求路径说明继续保留，不改统计口径
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
       - 新增“运行状态脚注应对过多透传路径做摘要收敛”断言
       - 新增“不应把所有透传路径完整展开”断言
       - 新增“进行中的代理请求路径仍应展示”断言
     - `node --check .\gateway.mjs`
     - `git diff --check`

34. 请求体超过本地上限时不应误记成 gateway 内部错误
   - 现象：
     - 日志出现：
       - `[error] Error: 请求体超过限制: 104857600 bytes`
     - 用户容易误判成 gateway 自身崩溃或上游异常
   - 根因：
     - `readRequestBody()` 超限时直接抛普通 `Error`
     - 顶层统一 catch 会把它按通用 `502 gateway_error` 和 `[error]` 堆栈收口
   - 处理：
     - 为请求体超限增加单独错误语义：
       - HTTP `413`
       - `type=gateway_rejection`
       - `code=request_body_limit_exceeded`
     - 日志改为摘要：
       - `[gateway-reject] request body too large path=... limit=... message=...`
     - 继续计入 `failed_proxy_request_count`
   - 额外修正：
     - 原默认 `request_body_limit_bytes = 10MB` 会挡住真实 Codex 大上下文请求
     - 默认值上调到 `100MB`
     - 安装脚本和复用迁移会把旧默认 `10MB` 自动升级到新默认
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
       - 新增“超限请求体应返回 413”断言
       - 新增“超限请求体应返回 request_body_limit_exceeded”断言
       - 新增“超限请求体应记录为 gateway-reject 摘要日志”断言
       - 新增“不应记录 [error] Error: 请求体超过限制”断言
     - `node --check .\gateway.mjs`
     - `git diff --check`

35. state 声称已安装不等于 provider 正在接管，配置迁移失败也不能把原健康 gateway 留在停止状态
   - 现象：
     - 电脑断电或外部 provider 工具改写后，`state.json` 仍存在，但 Codex `base_url` 可能已经绕过 gateway。
     - 重复运行启动入口会无条件重写配置或重启健康 gateway。
     - PID 文件指向存活进程时，如果该进程不是健康 gateway，旧逻辑仍可能误判为已运行。
     - PID 复用或陈旧 PID 指向无关存活进程时，旧重启逻辑会直接终止该进程。
     - `latest_backup_path` 为空时重新接管，后续“恢复原配置”没有可用恢复点。
     - 切换到新的真实 provider 时，旧逻辑会复用上一 provider 的有效备份，导致恢复到错误 provider。
     - `latest_backup_path` 指向目录时，旧恢复逻辑会先停止 gateway，再在复制阶段失败。
     - state 仍在但 gateway `config.json` 丢失时，退回安装分支会把已经指向 gateway 的 Codex 配置误存成恢复点。
     - `config.json` 丢失且旧 gateway 仍健康时，失败迁移会遗留新配置或丢失健康实例的 PID 管理状态。
     - 直接调用 install 时仍走独立旧逻辑，无法复用 launch 的运行时配置恢复和回滚事务。
     - start 未指定 restart 时只要 PID 存活就直接返回，陈旧 PID 会阻止真正启动。
     - stop/restore 在 `config.json` 丢失时无法验证进程，却会删除 PID/state 并留下占端口的孤立 gateway。
     - 新进程健康等待只看 HTTP 200，可能接受另一进程返回的 health。
     - 新 child 保持存活但 health 超时/身份不匹配时，start 抛错却不终止自己创建的 child；上层 stop 又因无法验证而拒绝终止，形成孤立进程。
     - PID 文件写入位于清理边界外时，写盘失败会在 health 验证前直接逃逸，同样留下无 PID 的 child。
     - 当前 provider 与 state 记录的 provider 不一致时，旧逻辑仍可能借用另一 provider 的 `original_base_url`。
     - 迁移 listen 地址后若新端口启动失败，旧健康 gateway 已被停止，文件虽然回滚但服务没有恢复。
   - 根因：
     - 安装身份、provider 当前接管状态、gateway 配置迁移需求与进程健康状态被混成一个布尔判断。
     - 回滚按整个 `catch` 粗粒度重写所有文件并停止进程，没有记录本次实际发生的写入和生命周期动作。
     - 备份逻辑只覆盖首次安装，没有区分“provider 指向真实上游”与“provider 已指向已管理 gateway”。
     - 退回安装分支时没有再次校验 state 的 provider 身份，Node 还只检查备份路径存在，没有确认它是普通文件。
   - 处理：
     - 安装身份按 `provider_name + codex_config_path + state/config` 判断；provider 漂移只恢复 `base_url`，不替换既有 upstream。
     - gateway 运行状态同时检查 PID 与 health；健康且配置无变化时保持文件字节、mtime、PID 和备份目录不变。
     - health 返回当前 `process_id`；只有它与 PID 文件一致时才允许停止进程，无法证明身份时只移除陈旧 PID。
     - 手工 install 作为 launch 的无 UI 包装，首次安装写入函数只由 launch 判定后内部调用，不再维护第二套恢复控制面。
     - start 无论是否要求 restart 都先校验 PID 与 health 身份；身份不匹配时只移除 PID 并继续启动。
     - stop/restore 在磁盘配置缺失时使用 state 的 gateway 地址读取 status，并再次绑定 PID；无法验证时抛错且保留 PID/state。
     - 启动后的 health 等待接收新 child PID，只有响应 `process_id` 匹配才返回成功。
     - start 从 PID 文件写入开始包进本地事务；写入、child 存活检查或 health 等待失败时直接终止自己创建的 child并等待退出。
     - 只有复查确认 child 已退出且 PID 文件仍等于该 child PID 时才删除；强制终止后仍存活则保留 PID，再重新抛出原始启动错误。
     - provider 指向真实上游且备份缺失/不可用时，接管前创建一次真实配置快照并写回 state；切换 provider 时强制创建当前 provider 的独立恢复点；provider 已指向 requested/state/config 中任一已管理 gateway 时不创建伪备份。
     - state 存在但 gateway 配置丢失时可以按已知 `original_base_url` 重建配置；旧 gateway 仍健康时优先从绑定 PID 的状态接口取回运行时配置并进入 reuse 事务；只有 provider 身份与配置路径匹配时才允许借用该 upstream。
     - 备份路径必须是普通文件；目录或失效路径在停止 gateway 前直接拒绝。
     - 配置迁移使用动作级回滚，只恢复本次实际写过的文件；启动失败时清理失败实例，恢复旧配置，并在旧实例原本健康时重新拉起。
   - 验证：
     - `node .\scripts\test-launch-ui.mjs`
       - 覆盖重复启动零写入、provider 漂移、直接 start/launch 的陈旧存活 PID 防误杀、错误 PID health 200 拒绝、PID 写失败与启动验证失败的 child/PID 清理、跨 provider 备份隔离、目录恢复点拒绝、缺失配置失败迁移和旧健康实例恢复。
     - `node .\scripts\test-launch-ui-unix.mjs`
       - 对 Unix/Node 管理核心执行同构场景。
     - `node .\scripts\test-install-restore.mjs`
       - 验证首次备份、手工 install 复用 launch 控制面、配置丢失重建、provider 身份与备份隔离、缺失配置 restore 进程收口、目录恢复点和恢复闭环未回归。

36. 主动探针不能把一个模型的 reasoning effort 画像无条件套给所有目标模型
   - 现象：
     - 最近真实请求为 `gpt-5.6-terra / ultra` 后，五模型主动探针会给 5.4、5.5 和 `gpt-5.6-luna` 也发送 `ultra`。
     - 上游可能因 effort 超出目标模型能力返回 `400`，探针再把该错误误当成模型契约违约证据。
   - 根因：
     - `activeProbeRequestProfile` 只有一个全局 effort，`applyActiveProbePayloadProfile()` 没有结合 payload 的目标模型做能力约束。
     - 被动采集支持完整 effort 集合与主动探针合法出站参数被混成同一集合。
   - 处理：
     - 被动采集继续完整接受 `minimal / low / medium / high / xhigh / max / ultra`。
     - 主动探针出站按目标家族约束 effort：5.4/5.5 为 `low..xhigh`，5.6 sol/terra 为 `low..ultra`，5.6 luna 为 `low..max`。
     - 长上下文探针日志记录最终实际发送的 effort，不再记录裁剪前画像。
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
       - 覆盖 5.6 三变体 × `minimal..ultra` 全采集矩阵、相似模型前缀隔离和公式模式跨模型 516/1034。
       - 先证明五模型请求全部错误继承 `ultra`，再验证各目标模型收到自己的合法上限值，并验证 `minimal` 统一按探针下限裁剪为 `low`。

37. AGOS 测试治理矩阵的 Root 应指向 rules component，不是产品仓根
   - 现象：
     - `generate-test-governance-matrix.ps1 -Root D:\Android_source\ai-growth-os` 报 `test governance profiles missing`。
   - 根因：
     - 该脚本把 `-Root` 解释为 rules root，并固定读取 `<Root>\registry\test-governance-profiles.yml`。
   - 处理：
     - 使用 `-Root D:\Android_source\ai-growth-os\components\rules`。
   - 验证：
     - 报告返回 `TEST_MATRIX_STATUS=ready`、`SIBLING_REGRESSION_GUARD_STATUS=passed` 和 `TEST_GOVERNANCE_MATRIX_OK`。

38. 严格 reasoning 全流缓冲会把客户端首字时间拖到接近响应完成，直接透传与超时改写必须按是否已写客户端分流
   - 现象：
     - 上游已经持续产生 SSE，但客户端长时间看不到首个有效输出，观测上首字时间接近整轮完成时间。
     - 如果为降低延迟直接提前写响应头，后续命中规则、Capacity、429 或 timeout 时已无法安全改写为 `502`。
   - 根因：
     - 既有 strict reasoning 路径必须在完整解析后才能判断 token/结构命中，因此会缓存整轮 SSE。
     - 上游首 chunk、首 content 与客户端首写是三个不同时间点；旧采集没有完整区分。
     - HTTP 响应一旦开始透传，状态码和已写字节不可撤回，不能在同一响应里重新派发并拼接第二轮结果。
   - 处理：
     - `intercept_rule_mode=none` 禁用 reasoning 命中、续写和专用剥离，未启用 latency guard 时直接边读边透传。
     - none + latency guard 只缓存首个有效输出前的 lifecycle/metadata，固定上限 `1MiB`；文字、commentary、final、tool/function call 才算 progress。
     - 总 deadline 从第一次上游派发开始并跨内部 attempt 保持不变；首 progress 重试与 reasoning、续写、Capacity、429 共用 `guard_retry_attempts`。
     - 未透传时 timeout 可返回稳定 `502`；已透传后只取消上游并断开连接，记录 `timeout_disconnected_after_forward`，不得伪装为 502。
     - analytics schema 升级为 `3`，补充 `policy_*`、`retry_*`、客户端首写、timeout 和 forwarding 字段；旧样本缺字段统一保持 `null`。
     - Windows/Unix 启动控制面保留合法 `none`、动作枚举和嵌套 `latency_guard`；旧 Capacity 布尔仅在新动作缺失时参与迁移，正确配置二次启动保持配置字节、mtime 和 PID 不变。
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
     - `node .\scripts\test-install-restore.mjs`
     - `node .\scripts\test-launch-ui.mjs`
     - `node .\scripts\test-launch-ui-unix.mjs`
     - `node --check .\gateway.mjs`
     - `node --check .\scripts\admin-lib.mjs`
     - PowerShell Parser AST 检查 `common.ps1`、`install-for-current-provider.ps1`、`launch-ui.ps1`
     - `git diff --check`

39. Retry-After 等待、客户端断连和前导缓冲必须在同一 attempt 内按最终事实收口
   - 现象：
     - 已完整收到 429 并进入 Retry-After 等待后，总 deadline 到期会从外层直接 `return`，客户端既收不到 502，也没有结束响应。
     - 该 attempt 在等待前已被落成 `http_429_internal_retry`，再次走 timeout 会产生重复或矛盾样本。
     - none + latency guard 会先把越界 chunk 压入前导数组，再发现已超过 `1MiB` 并刷新，因此固定值不是严格内存上限。
     - 客户端主动断开与上游断流共用 AbortError，若不先检查客户端信号会误记为 upstream terminated。
   - 根因：
     - 策略 handler 过早完成 retry 计数、模型统计和 attempt 样本，等待结果不再拥有可收口的原始 sample。
     - 外层只把 `waitForRetryDelay=false` 当作停止信号，没有区分 total timeout 与 client disconnect。
     - 前导缓冲在 push 后才比较累计字节数，单个网络 chunk 可以让数组瞬时越界。
   - 处理：
     - 策略 handler 只返回 retry 意图；等待真正完成后才记录策略 retry、扣共享预算并创建下一 attempt。
     - 等待被总 deadline 中断时，用同一未完成 sample 调用 timeout 收口并返回 `upstream-total-timeout` 502；客户端断开则记录 `client_disconnected`。
     - 前导 chunk 在 push 前计算累计值；将越界时先刷已有块，当前 chunk 直接写给客户端。
     - `endpoints` 作为 reasoning、Capacity、429、latency 的统一管理边界；timer 阈值限制为 `0..2_147_483_647`。
   - 防回归：
     - `node .\scripts\test-gateway-e2e.mjs` 使用两个独立临时网关做确定性故障注入，分别覆盖 deadline 中断等待和前导数组硬上限。
     - deadline 用例要求 HTTP 502、`upstream_total_timeout`、只发一次上游请求且只落一个 `total_timeout_returned_502` sample。
     - 缓冲用例要求大于 `1MiB` 的无 progress 元数据仍返回 200，并记录 `timeout_response_control_lost=true` 与 `response_forwarding_started=true`。

40. 分层策略的 attempt 统计、流解析和配置幂等必须覆盖断连与非标准响应
   - 现象：
     - 客户端在上传请求体时断连会被误记成 `request_rejected + 413`，看起来像请求体超限。
     - SSE 长时间没有事件分隔符时，未完成事件字符串可持续增长；慢速 `text/plain` 等非 SSE 流也不会结束首 progress 计时。
     - timeout、Retry-After 等待中断连和 observe-only 命中后断连会出现 inspected/failed 重复、timeout 不进 inspected 分母或 `matched_current_rule` 丢失。
     - `latency_guard` 等对象仅调整成员顺序时，安装/启动脚本仍会写盘，并可能重启已经健康的 gateway。
   - 根因：
     - 请求体读取异常统一走 413 分支，没有区分 `ECONNRESET` / request abort，也没有保留实际已读字节。
     - SSE parser 只等待分隔符后再切块，非 SSE chunk 又没有作为有效输出信号。
     - inspected 计数散落在多个 timeout、策略等待和 stream catch 分支，没有 attempt 级幂等；断连收口使用了默认 `matched=false`。
     - 配置比较直接比较序列化文本，错误地把对象键顺序当成配置语义；数组顺序则必须继续保留。
   - 处理：
     - 请求体读取错误携带 `requestBodyBytesRead`；只有真实超过上限才记录 `413 request_rejected`，客户端断连记录 `client_disconnected` 和实际读取字节。
     - SSE 未完成事件超过 `1MiB` 后进入 bounded discard 状态，只保留识别后续边界所需的尾部；非 SSE 的首个非空 chunk 直接标记 first content/progress。
     - 使用 attempt sample 级 `recordInspectedResponseForSample()` 去重；取得上游响应后的 timeout 计入 inspected，Retry-After 断连不再同时增加 failed，observe-only 断连复用已经观察到的规则命中事实。
     - Node 与 PowerShell 配置比较都递归排序对象键，但保持数组原顺序，合法配置仅成员换序时不写盘、不改 mtime、不重启 PID。
   - 防回归：
     - `test-gateway-e2e.mjs` 覆盖上传断连、慢速非 SSE、超大无分隔 SSE、Retry-After 断连、timeout 计数恒等式和 observe-only 命中后断连。
     - `test-install-restore.mjs`、`test-launch-ui.mjs`、`test-launch-ui-unix.mjs` 都覆盖嵌套配置成员换序后的字节、mtime 与 PID 幂等。

41. Windows 已退出进程对象仍可能存在，不能只凭 Get-Process 判断存活
   - 现象：
     - `test-launch-ui.mjs` 稳定失败于 `PowerShell failed-start cleanup left its child PID file behind`。
     - PowerShell cleanup helper 已返回，子进程也确实停止，但 PID 文件没有删除。
   - 根因：
     - Windows 上已终止进程在父进程仍持有句柄时，`Get-Process -Id` 短时间仍能返回对象，此时对象的 `HasExited=true`。
     - `Test-ProcessAlive` 旧实现只要 `Get-Process` 成功就返回 true，导致 `Stop-FailedGatewayStart` 跳过 PID 文件清理。
   - 处理：
     - `Test-ProcessAlive` 改为返回 `-not $process.HasExited`；找不到进程时仍返回 false。
   - 防回归：
     - RED：`node .\scripts\test-launch-ui.mjs` 稳定失败于失败启动 PID 文件残留。
     - GREEN：同一命令通过 `PASS launch-ui flow`；随后四套 E2E 串行 fresh 通过。

42. SSE 检查与 Retry-After 必须防止协议误标、超大事件和 timer 排序绕过
   - 现象：
     - 精确 Capacity 特征优先于通用 429 后，Capacity 429 会忽略正值 `Retry-After` 并立即重试。
     - 事件循环阻塞时，Retry-After timer 可在总 deadline timer 回调前恢复 continuation，导致 deadline 已过仍派发新 attempt。
     - SSE parser 只识别 `\n\n` / `\r\n\r\n`，误标为 `text/plain` 的合法 JSON SSE、`\n\r\n` 混合空行和单个超过 1 MiB 的 completed 事件会丢失 reasoning/结构信号。
     - parser 旧实现先拼接完整字符串再检查长度，不是严格 1 MiB 状态上限；observe-only 命中后 timeout 又会把样本 `matched_current_rule` 覆盖为 false。
   - 根因：
     - Retry-After 解析错误地依赖策略 trigger，而不是实际 HTTP 429 状态；等待结束后只依赖 timer abort，没有按墙钟复核 deadline。
     - SSE framing 使用字符串固定分隔符和 Content-Type 单一判定；超限事件被静默丢弃，严格保护把“无法检查”误当成“未命中”。
     - inspected helper 只更新计数，不把已经观察到的命中事实写回 attempt sample；timeout 收口硬编码 `matched=false`。
   - 处理：
     - 所有实际 HTTP 429（包括 Capacity）统一解析 `Retry-After`；等待完成后调用 latency guard 墙钟检查，过期时复用当前 attempt 返回总 timeout 502。
     - parser 改为 Buffer 字节级 framing，支持 LF、CR、CRLF 混合空行；正常状态最多保存 1 MiB，discard 状态最多保存 3 字节边界尾巴，并按 64 KiB 分片扫描输入。
     - 非 JSON 流式响应同时做有界 `data: {json}` 识别；普通非 SSE 非空 chunk 仍算首 progress。
     - `none`/observe-only 的超大事件保持透传并记录检查失败；严格 reasoning 保护返回 `502 response_inspection_limit_exceeded`，样本落 `final_action=response_inspection_limit_exceeded` 与同码 failure summary。
     - attempt inspected helper 一旦观察到命中即写回 sample；timeout 三个最终分支继承该值。
   - 防回归：
     - `test-gateway-e2e.mjs` 新增 Capacity 正值等待、late timer deadline、混合换行、误标 Content-Type、超大 protected completed、parser 硬上限故障注入和 observe-only timeout 七组反例。
     - 2026-07-15 Codex bundled Node 四套 E2E 串行 PASS，六个 JS syntax、PowerShell AST、`git diff --check` 与临时进程审计 PASS。

43. 策略重试的同步收口、SSE EOF 和 disconnect 检查失败必须按不可撤回边界处理
   - 现象：
     - Retry-After timer 恢复时虽然 deadline 尚余约 20 ms，但旧 retry attempt 的同步 analytics 入库可以阻塞事件循环；第二次上游请求最终在总 deadline 之后才真正到达。
     - 误标 `text/plain` 的 SSE 首 chunk 只有 `data:`、JSON 位于下一 chunk 时，会被当成普通文本 progress。
     - 唯一 `response.completed` 事件用 `\r\r` 结束后立即 EOF 时，最后一个 CR 一直被保留等待潜在 LF，516 可绕过最终规则判断。
     - `stream_action=disconnect` 已发送 200 响应头后遇到超过 1 MiB 的受保护事件，旧超限分支因不是 strict-502 模式而继续透传。
   - 根因：
     - “调用 `fetch()` 返回 Promise”不等于请求已经离开 Node/Undici 事件循环；在其后立即同步收口仍可能挡住真实网络派发。
     - 误标 SSE 嗅探只接受 `data: {` 或 `data: [DONE]`，没有在字段前缀阶段切换到 SSE framing。
     - chunk 解析必须把末尾 CR 保留到下一块判断 CRLF，但 EOF 分支没有允许尾随 CR 的 final flush。
     - 检查上限只受 `strict502Mode` 控制，没有覆盖 reasoning 规则启用但响应已不可改写的 disconnect 模式。
   - 处理：
     - policy retry 等待完成后先保留旧 attempt 上下文；下一轮在派发前做最终墙钟检查。过期时用旧 sample 返回总 timeout；未过期时启动下一 fetch 并让出两个有界事件循环轮次，再按预先捕获的旧 attempt 结束时间同步完成日志、计数和样本，不等待下一响应头。
     - `total_proxy_request_count` 与 active 计数移动到实际 fetch attempt，未派发的 deadline 分支不计数，也不记录新 attempt。
     - 误标 SSE 从行首 `data:` / `event:` / `id:` / `retry:` / comment 前缀开始识别；EOF 使用只在终止阶段允许尾随 CR 的 `flushSsePayloads()`，完整事件继续进入模型、usage、结构与 reasoning 累积。
     - reasoning 流式保护启用且检查超限时统一 fail-closed：未写响应返回专用 502；已写响应取消 reader/upstream、销毁下游并记录 `response_inspection_limit_disconnected_after_forward`。
   - 防回归：
     - deadline 故障注入让旧 `http_429_internal_retry` 样本同步入库跨过总 deadline，并断言第二次上游实际接收时间仍早于 deadline；第一版仅提前创建 fetch Promise 仍以 239 ms 对 220 ms 失败，最终后移同步收口后转绿。
     - E2E 覆盖 `data:` 与 JSON 跨 chunk并暂停、纯 CR completed 后立即 EOF、disconnect 已写响应后的受保护超大事件断连和专用样本。
     - 2026-07-15 Codex bundled Node 四套 E2E 串行 PASS，六个 JS syntax、三份 PowerShell AST、`git diff --check` 与仓库临时 Node 进程 0 残留。

44. 所有共享 retry、误标 SSE 和 attempt 计数必须使用统一状态机口径
   - 现象：
     - 第三批最终 deadline 闸门只覆盖 Capacity/429；reasoning guard、续写和首 progress timeout 的同步折叠、日志或样本收口仍可跨过 deadline 后继续派发。
     - 旧 policy sample 等到下一 fetch 返回响应头才落盘；下一 fetch 挂起时旧样本长期不可见，duration/TPS 还包含下一 attempt 的等待。
     - 误标 SSE 只识别完整字段前缀，首 chunk 为 `d` / `eve` / `i` / `ret` 会被误算普通文本 progress；反向把完整 `id:` / `retry:` / comment 普通文本永久当 SSE。
     - 流首 UTF-8 BOM 会让首行变成 `\uFEFFdata:`，唯一 completed 事件中的 516 被漏掉。
     - EOF flush 才确认命中时，disconnect 模式因不能返回 502 而被降成 observe-only；final-answer-only 同样受影响。
     - 前一 attempt 已记 inspected 后，下一 fetch failure 只记录样本却不增加 failed，破坏 `total = inspected + bypassed + failed + active`。
   - 根因：
     - retry 的预算递增、样本完成和继续循环分散在四个分支，没有统一的“未派发 pending -> deadline gate -> 已派发”状态。
     - 用 fetch Promise resolve 当作派发确认会把旧 attempt 生命周期绑定到下一响应头；只创建 Promise 或只让出一次 `setImmediate` 又不足以让 Node/Undici 在确定性故障注入下写出请求。
     - Content-Type 误标本身存在协议歧义，需要待判态，而不是遇到完整保留字段就永久切换布尔值。
     - request-level outcome 不能替代 attempt-level inspected/failed 分类。
   - 处理：
     - 四种 retry 都生成 `pendingRetryDispatch`，不提前扣预算或完成 sample；下一轮可覆盖首 progress timeout 地复核总 deadline。允许派发时先启动 fetch 并连续让出两个 check/poll 轮次，再完成旧 sample；过期时仍用旧 sample 返回总 timeout。
     - pending 对象捕获 `requestFinishedAtMs` 与 `latestLogSeq`；旧样本不等待下一响应头，挂起 fetch 下仍及时可见，duration/TPS 不跨 attempt。续写次数与 timeout retry 次数也只在进入派发轮次后增加。
     - parser 使用有界 tri-state：字段名部分前缀保持待判，JSON data 确认为 SSE，完整不可识别事件回退普通文本；parser 副本忽略可跨 chunk 的流首 UTF-8 BOM，原始下游字节不改。
     - EOF 最终命中且 `stream_action=disconnect` 时统一记录实际 blocked/matched，取消上游并 `res.destroy()`；reasoning 与 final-only 共用该分支。
     - 当前 attempt 尚未 inspected 而失败时在内层 catch 单独增加 failed 并写 request outcome，外层兜底不再因前序 inspected 状态漏计或重复计数。
   - 防回归：
     - 同一计时故障模块分别让 `http_429_internal_retry`、`internal_retry`、`continuation_recovery`、`first_progress_timeout_internal_retry` 的同步入库跨过 220 ms deadline，四类第二次上游请求都必须在 deadline 前实际收到。
     - 第二 fetch 延迟 800 ms 且 latency guard 关闭时，旧 429 sample 必须在 250 ms 观测窗口内出现，且自身 duration 小于 500 ms。
     - E2E 覆盖 `d/eve/i/ret` 字段内部拆分、`id:`/comment 普通文本回退、BOM completed 516、纯 CR EOF reasoning/final-only disconnect，以及 429 后连续 fetch failure 的全局计数恒等式。

45. SSE 候选组合与 latency 完成路径不能依赖剩余 buffer 或 timer 回调顺序
   - 现象：
     - 误标 `text/plain` 的首个 completed 事件超过 1 MiB 时，超限瞬间尚未解析 JSON，`sse_like=false`，516 事件被 discard 后可按未命中透传。
     - UTF-8 BOM 单独占一个 chunk 时，parser 删除 BOM 后 buffer 为空，但原始 chunk 非空，旧逻辑会错误清除首 progress timer。
     - 同一 chunk 为 `id: ordinary\n\nd` 时，完整非 JSON block 已应回退普通文本；parser 消费该 block 后只剩候选 `d`，旧逻辑重新进入 pending 并返回错误的首 progress 502。
     - timer 回调被事件循环延迟时，非流式 body 或流式 progress/EOF 可先恢复并清 timer，使 first-progress 或 total 硬阈值失效。
   - 根因：
     - `sse_like` 只表达已确认 SSE，无法表达“超限前是候选”；progress 又只从解析后剩余 buffer 反推，丢失 BOM removal 与本 chunk fallback 事实。
     - latency guard 只有 timer phase，没有保存首 progress 绝对截止时间；完成路径默认 timer 已按时执行。
   - 处理：
     - parser state 增加 BOM removal、unrecognized event、active candidate 与 oversized candidate 计数；`inspectSseChunk()` 返回本 chunk 事实。候选超限参与 inspection failure，BOM-only 不算 progress，unrecognized fallback 优先于尾随候选。
     - guard 保存 `firstProgressDeadlineAtMs`；`markFirstProgress()` / `endFirstProgressWindow()` 先按墙钟判定。非流式 body、流式 chunk 和 EOF 先复核 total（可覆盖已触发 first-progress），再清 timer或写客户端。
     - 未派发 total timeout 的 `retry_trigger/retry_delay_ms` 明确保持 `null`；policy 旧 sample 使用派发前捕获的 evidence 上界，不把下一 attempt 日志纳入自身范围。
   - 防回归：
     - E2E 覆盖 standalone BOM 后暂停、ordinary fallback + 尾随 `d`、误标超大 completed 516。
     - 独立 fault gateway 把 45 ms first-progress 与 70 ms total timer 回调延迟到 200 ms；上游分别在 80/100 ms 产生 progress/body，仍必须按墙钟返回对应 502。
     - pending sample 额外断言唯一性、`request_finished_at_ms` 早于第二次上游接收、duration 与 evidence 上界存在；未派发 Retry-After timeout 断言 retry 字段为空。

46. 检查上限必须先于 progress/timeout，测试证据不能依赖预热事件或跨进程毫秒墙钟
   - 现象：
     - “误标首个超大候选”用例默认先生成普通输出，parser 已进入 confirmed SSE，无法证明首个事件超过 `1MiB` 时仍会 fail-closed。
     - 超大候选在同一 chunk 完成边界后可能先被当成普通文本 progress；first-progress 已过期时又可能先走 timeout，绕过专用检查失败收口。
     - timer 回调延迟时，连续 lifecycle/metadata chunk 不会主动复核 first-progress 墙钟，要等有效输出、EOF 或迟到 timer 才超时。
     - JavaScript 字符切分只能覆盖完整 BOM 独立成块，不能覆盖 `EF BB BF` 三个 UTF-8 字节跨网络 chunk。
     - pending sample 测试严格比较 gateway 与假上游两个进程的 `Date.now()`；Windows 实测出现 4ms 回拨，导致因果顺序正确但断言偶发失败。
   - 根因：
     - 测试 fixture 没有关闭默认输出事件；生产分支又把检查上限放在 progress 与 timeout 处理之后。
     - first-progress 的绝对截止时间只在有效 progress/EOF 路径复核，没有覆盖每个已到达的流式 chunk。
     - 字符切分与网络字节切分不是同一层语义；跨进程墙钟也不是单调因果时钟。
   - 处理：
     - 超大候选用例设置 `test_stream_only_completed_event=true`，保证首个且唯一事件就是带 516 的超大 completed。
     - 抽出统一检查上限收口函数，并在 progress/first-progress timeout 之前执行；随后每个 chunk 在 progress 分类前调用 first-progress 墙钟复核。
     - fake upstream 增加 Buffer 字节切分，直接覆盖 BOM 三字节跨 chunk。
     - pending sample 断言增加日志游标，要求 `evidence_log_seq_range.to` 早于本次 `internal_retry` 完成日志；跨进程时间比较只保留 50ms 时钟容差，不放宽样本唯一性、duration 或 evidence 顺序。
   - 防回归：
     - fault gateway 将 200ms first-progress timer 延迟到 500ms，并在超大候选累积到 `1MiB` 时阻塞 230ms，断言检查上限仍先返回 `response-inspection-limit-exceeded`。
     - 47ms first-progress timer 被延迟时，上游 80ms 后连续发送 lifecycle，首个过期 chunk 必须立即返回 502。
     - 修正后 `test-gateway-e2e.mjs` 单轮 GREEN，并连续 3 轮稳定性复跑全部 GREEN；此前五轮稳定性基线也全部 GREEN。

47. 总 deadline 必须覆盖同步处理、真实派发和异常终态，采集/配置比较要按最终事实
   - 现象：
     - pending retry 在 loop 顶部通过 deadline 检查后，header clone 等同步工作仍可跨线，随后错误增加预算、代理总数并真实派发第二次上游请求。
     - 上游 body/chunk 在 deadline 前到达，但 JSON/SSE 解析或结构遍历跨线后仍可写出 200；reader 在 deadline 后异常且 timer 回调被阻塞时会被误记为普通 stream termination。
     - 非流式 observe-only 在客户端写入前先 clone/落盘，导致 `client_*` 与 `response_forwarding_started` 永久为空。
     - Capacity/429 trigger 与最终 outcome 一起延后，Retry-After 等待中断时 trigger 漏计。
     - PowerShell canonical helper 把函数参数里的字符串、数字、布尔当成对象，字符串数组变成 `Length` 对象，标量数组变成 `{}`。
   - 根因：
     - deadline 复核没有紧邻真实 fetch 和不可撤回客户端写入，过度依赖 timer 在同步 JavaScript 执行期间抢占。
     - attempt 计数早于 fetch；observe-only 样本早于 `markReasoningSampleClient*`；策略 trigger/outcome 由一个 helper 同时累加。
     - PowerShell 的参数包装让标量在递归函数里可能命中 `PSCustomObject` 分支，标量判断顺序错误。
   - 处理：
     - 先完成 header/request 准备，再执行 pending/current total deadline 最终闸门；调用 fetch 后才更新预算、total 和 active。
     - 非流式解析/脱敏后、流式解析/结构后、EOF、reader catch 与每次 forwarding 前复核 total；reader catch 同时复核 first-progress。
     - observe-only 样本在 `res.end()` 后完成；策略分类时记 trigger，动作完成时分别记 retry/pass/502。
     - canonical helper 在对象递归前直接返回 `string` 与 CLR `ValueType`，数组继续按原序递归。
   - 防回归：
     - header clone 故障注入只阻塞第二次真实 dispatch 到 deadline 后，断言只发 1 次上游、预算仍为 0、代理总数只加 1。
     - JSON 与完整 SSE payload 解析分别阻塞 100ms，70ms timer 延迟到 200ms；reader 在 100ms 断流，三种路径都必须返回 total-timeout 502。
     - observe-only 断言客户端首写字段；Retry-After 断连断言 trigger+1/retry 不变；Windows launch 断言标量数组 canonical JSON。
     - gateway E2E 连续 3 轮 GREEN，三套生命周期 E2E 全部 GREEN，临时 gateway 进程残留为 0。

48. 未派发 current attempt 不能抢走 pending 终态，首 progress 和最终写入必须绑定真实边界
   - 现象：
     - pending 旧 guard 首次 total 检查尚未过期、current guard 紧接着过期时，旧 sample 丢失，落盘的是 `upstream_fetch_started_at_ms=null` 的伪 attempt 2，inspected 还重复增加。
     - current 首 progress timer 在 header clone 前启动；同步准备跨过首 progress 但未跨 total 时，第二次上游仍被派发并错误返回 first-progress 502。
     - 非流式 Capacity/429 502、策略透传和 reasoning block 在最后一次 total 检查后仍会执行 logger、模型归档、错误体构造或 header copy；同步工作跨线后仍写原策略响应。
     - fetch 被 first-progress abort 后，rejection 直到 total deadline 之后才恢复时，旧代码仍按 first-progress 收口。
     - 续写安全模式的 Capacity/429 pass-through 直接发送原始 `bodyBuffer`，可泄露 `encrypted_content`。
   - 根因：
     - pending 与 current 各自做 deadline 检查，但第二个闸门的 timeout 分支固定绑定 current 局部 sample；current guard 又早于真实 fetch 创建。
     - 非流式多个早退分支没有统一的“同步准备完成 -> 最终墙钟复核 -> 首次 writeHead”不可撤回边界。
     - fetch outcome 先抛 rejection、后检查 total，且策略透传绕过普通非流式脱敏出口。
   - 处理：
     - 第二个 total gate 过期且存在 pending 时，强制用 pending 的 guard、sample、模型和结构收口；current attempt 只有真实 fetch 后才记预算、代理总数和 active。
     - current latency guard 在 header/request 准备完成后创建，首 progress 从真实派发邻近位置开始；请求级 total deadline 仍跨 attempt 不重置。
     - 非流式所有未写终态先完成模型归档、错误体或 header 准备，再紧邻 `writeHead` 复核 total；timeout 写入前清理尚未发送的上游 header，策略 outcome/blocked 只在闸门通过后计数。
     - fetch resolve/reject 以及 catch 都先以 `overrideExisting=true` 复核 total，再复核 first-progress；总 deadline 已过时覆盖较早 phase。
     - Capacity/429 pass-through 在续写安全模式下复用 `stripEncryptedContentFromBodyBuffer()`；none 模式不启用该标志。
   - 防回归：
     - 故障注入让 pending 检查看到 deadline 前 1ms、current 检查看到已过期，断言只落 attempt 1、只发一次上游、预算仍为 0 且 attempt 恒等式成立。
     - 第二次 header clone 阻塞 80ms，first-progress=40ms、total=220ms；正常第二次上游必须返回 200，证明本地准备不消耗首 progress 窗口。
     - Capacity 502、HTTP 429 pass-through 与 reasoning block 分别在最终同步准备中阻塞 100ms，延迟 timer 回调后仍统一返回 total-timeout 502。
     - first-progress=40ms、total=60ms 的 fetch rejection 被阻塞到 80ms，最终只能增加 total timeout；续写 Capacity pass/retry-exhaust 两条路径都不得出现 key 或 secret。
     - lifecycle 反例记录上游 chunk 实际发送时间，硬证明既有 deadline 前 chunk，也有首次跨线的后续 chunk。
     - 2026-07-15 gateway E2E 首轮 GREEN 并连续 3/3 稳定复跑；install-restore、Windows launch、Unix launch、六个 JS syntax、三份 PowerShell AST、完整 diff check 与临时进程 0 残留全部 PASS。

49. total 与 first-progress 的真源必须是首次真实 fetch，语义完成和模型洞察都只能收口一次
   - 现象：
     - 请求级 total 在循环前建立；首次 header clone 跨过极小 deadline 时，上游请求数为 0，但 timeout handler 增加 inspected 并持久化 `upstream_fetch_started_at_ms=null` 的 attempt，破坏计数恒等式。
     - current guard 虽已移到 header clone 后，仍早于最终 total gate 和 fetch；该窄窗口阻塞可派发一个在上游调用前就过期的 first-progress attempt。
     - 非流式 body 与 EOF 事件在 deadline 前到达后，代码先清 first-progress timer，再做 JSON/SSE 语义解析；解析跨线仍返回 200。
     - 流式 `ensureClientHeaders()` 先检查 total、后复制 header；header copy 跨线仍会执行不可撤回 `writeHead(200)`。
     - 非流式终态在 `finalizeModelInsights()` 后跨 total，timeout catch 再提交一次模型洞察，单 attempt 的 local model 与 consistency 计数增加 2。
   - 根因：
     - total 和 attempt guard 的创建点描述“候选 attempt”，没有绑定真实 `fetch()` 派发事实；pending gate 与后续派发时间又使用不同的墙钟采样。
     - first-progress 窗口按“字节到达”提前关闭，而规则定义需要等语义解析确定是否为有效输出。
     - header copy 和模型洞察提交缺少统一幂等/不可撤回边界。
   - 处理：
     - 首次 `upstreamFetchStartedAtMs` 捕获后建立请求级 total；同一时间值传入 `createAttemptLatencyGuard()`，first-progress 绝对截止线固定为 `upstreamFetchStartedAtMs + limit`，timer 只按剩余时间唤醒。
     - pending 的最终 total gate 接受已捕获 `nowMs`，检查通过后立即使用同一时间调用 fetch；首次本地 header 准备不计入上游 total/first-progress。
     - 非流式与 EOF 在 payload 解析、usage/结构累积后，由 `markFirstProgress()` 或 `endFirstProgressWindow()` 按绝对墙钟收口。
     - 流式未写头时先复制可撤回 header，再复核 total，统一 timeout handler 清掉尚未发送的上游 header。
     - 使用 `WeakSet` 按 model context 保证 `finalizeModelInsights()` 每个 attempt 只执行一次。
   - 防回归：
     - 首次 header clone 阻塞 80ms、total=40ms，仍应在真实 fetch 后返回 200，并保持 total/inspected 各 +1；旧实现稳定复现 0 次上游、inspected+1。
     - guard 到 fetch 的 80ms 故障、pending gate 与派发时间分裂故障分别证明首 progress 锚点和单一最终 gate。
     - 非流式 JSON 与 EOF-only completed 事件各阻塞 100ms，必须返回 first-progress 502；流式 header copy 阻塞 100ms 必须在 writeHead 前返回 total 502。
     - Capacity timeout 带 `model=gpt-5.4`，精确断言 local model 和 consistency 只增加 1。
     - lifecycle 样本必须满足 `first_stream_chunk_at_ms - upstream_fetch_started_at_ms < first_progress_timeout_ms`，并最终按 first-progress timeout 收口。
     - 2026-07-15 gateway E2E 首轮 GREEN 并连续 3/3 稳定复跑；三套生命周期 E2E、六个 JS syntax、三份 PowerShell AST、完整 diff check 与临时进程 0 残留全部 PASS。

50. 预期流终止的同步收尾仍必须服从最终 deadline，故障 timer 区间必须按实际剩余时间隔离
   - 现象：
     - `reader.read()` 在 deadline 前抛出 `TypeError("terminated")` 后，首次 total/first-progress 检查通过；模型归档、日志或错误体构造同步跨线时，strict 模式仍返回普通 `gateway_error` termination 502。
     - `none + latency_guard` 在首 progress 前收到 lifecycle 并随后断流；模型归档同步跨过 first-progress 后，旧代码仍 flush 前导块并以 200 正常结束，样本 `timeout_phase=null`。
     - 原 47ms lifecycle 反例偶发在 guard 建立时只剩约 45ms，与前一个已消费的 timer fault bucket 碰撞；timer 抢先触发后，上游没有形成 deadline 后 chunk，测试会非确定性失败。
   - 根因：
     - expected-termination 分支只在同步终态准备前复核 deadline；strict 分支直接 `writeHead(502)`，非 strict header helper 只最终复核 total，没有最终复核 first-progress。
     - timer fault 按配置阈值设计相邻区间，但真实 guard timer 使用 `deadline - Date.now()` 的剩余时间，创建开销会把 47ms 压入 45ms 区间。
   - 处理：
     - reader 终止事实先写入 `upstream_stream_terminated`；模型归档、日志和错误体保持可撤回，strict 写头前按 `total -> first-progress` 最终复核。
     - 非 strict 只在 expected-termination flush 路径启用 first-progress 最终 gate；可撤回 header copy 后、`writeHead` 前复核，避免影响普通流式首写。
     - lifecycle 故障注入最终改用 500ms 阈值和 60 个 lifecycle 事件，并将 `300..500ms` timer 统一延迟到 800ms，避开一次性 bucket 被同值 timer 提前消费。
   - 防回归：
     - 错误体构造阻塞 100ms 必须把 strict termination 收成 `upstream_total_timeout` 502；指定模型归档阻塞 100ms 必须把 lifecycle-only termination 收成 `upstream_first_progress_timeout` 502。
     - 两条 timeout 样本必须保留 `upstream_stream_terminated=true`，并分别落 `total_timeout_returned_502` 与 `first_progress_timeout_returned_502`；500ms 内正常前导断流仍为 200。
     - 2026-07-15 Codex bundled Node gateway E2E 首轮 GREEN、连续 3/3 稳定复跑 GREEN，最终遥测断言补强后再次 GREEN；round-11 扩大到 500ms 后再次首轮 GREEN 与 3/3 稳定复跑 GREEN。install-restore、Windows launch、Unix launch、六个 JS syntax、三份 PowerShell AST、完整 diff check 与临时进程 0 残留均通过。

51. 客户端首写采集必须取真实写入时刻，不能复用 header copy 前的缓冲时间
   - 现象：
     - `flushBufferedChunksToClient(Date.now())` 在 `ensureClientHeaders()` 前捕获时间；同步 header copy 较慢时，`markReasoningSampleClientWrite()` 会把这个旧值写成 `client_first_write_at_ms`。
     - 两名独立 reviewer 均确认该路径可产生 `client_first_write_at_ms < client_headers_sent_at_ms`，虽不改变 HTTP 行为，却会低估首写耗时并污染后续时序分析。
   - 根因：
     - 同一个 timestamp 参数同时承担“上游 chunk 处理时刻”和“客户端真实写入时刻”；前者应保存在 `first_stream_chunk_at_ms/final_chunk_at_ms`，后者必须由客户端写边界单独采样。
   - 处理：
     - `writeClientChunk()` 在 `ensureClientHeaders()` 返回后调用无显式时间参数的 `markReasoningSampleClientWrite()`，由它紧邻 `res.write()` 现取 `Date.now()`。
     - `flushBufferedChunksToClient()` 不再接收或传播旧 timestamp；普通直写、首 progress flush、缓冲上限 flush 和 expected-termination flush 共用同一真实写边界。
   - 防回归：
     - fake upstream 为 termination 响应附加专用测试 header；fault preload 在 `copyHeadersToClient()` 阻塞 100ms，并断言响应仍为 200、阻塞真实发生、`client_headers_sent_at_ms <= client_first_write_at_ms`。
     - RED 精确复现 header 在 `1784095029696ms` 发送、首写却记录为 `1784095029596ms`；GREEN 后完整 gateway E2E 首轮通过并连续 3/3 稳定复跑。
     - 2026-07-15 install-restore、Windows launch、Unix launch、六个 JS syntax、三份 PowerShell AST、完整 diff check 与临时进程 0 残留全部通过。

### 2026-06-26 实测证据

- 假上游 E2E
  - `test-gateway-e2e.ps1` 通过
  - 已验证 root 路径和 `/v1` 路径都能区分 `516` 与 `128`
- 安装/恢复闭环
  - `test-install-restore.ps1` 通过
  - 已验证 UI 页面、状态接口、日志接口、516 统计、热更新配置、UI 恢复闭环
- 一键启动入口
  - `test-launch-ui.ps1` 通过
  - 已验证首次启动自动安装、再次启动自动复用、UI 页面可达、默认 `516 -> 502` 规则仍生效
- Unix shell 入口
  - `test-launch-ui-unix.ps1` 通过
  - 已验证 `.sh` 入口能完成启动、透传、恢复闭环
- Bash 默认入口实机验证
  - `bash ./scripts/launch-ui.sh --no-open` 通过
  - 输出 `mode=reuse`
  - `GET /__codex_retry_gateway/health` 返回 `200`
  - `GET /__codex_retry_gateway/ui` 返回 `200`
  - `GET /v1/models` 返回 `200`，并继续透传到真实上游
- Bash 入口后的 `codex exec` 实机验证
  - 命令退出码 `0`
  - 最后一条消息文件返回 `OK`
- 当前真实 provider
  - 当前 Codex 配置里的 `base_url` 已可切到 `http://127.0.0.1:4610`
  - 当前 gateway 运行配置里的 `upstream_base_url` 会指向用户自己的真实上游
  - `GET /__codex_retry_gateway/health` 返回 `ok=true`
  - `GET /v1/models` 已经经本地 gateway 成功透传到真实上游
  - `GET /__codex_retry_gateway/ui` 已实机打开，页面显示当前 upstream、provider、config 路径和 516 规则
- 真实 `codex exec`
  - gateway 停止时，CLI 真实提示：
    - `url: http://127.0.0.1:4610/responses`
    - 并自动进入 `Reconnecting...`
  - gateway 恢复后，`codex exec` 在临时目录再次成功返回 `OK`
