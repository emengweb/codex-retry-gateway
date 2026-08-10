# 上游错误策略与系统主题模式设计

## 目标

为 Gateway 增加可独立配置的上游错误策略，并在保持管理页主题控件位置和样式的前提下支持跟随系统主题。改动不重启或替换当前 `127.0.0.1:4610` 实例。

## 已确认范围

- 保留现有 Capacity 和 HTTP 429 配置字段、UI 与行为。
- 新增模型未配置/不可用、HTTP 502/503、其他 HTTP 4xx、其他 HTTP 5xx、`error.message` 兜底五项策略。
- 五项新增策略都使用既有四种动作下拉项，默认 `retry_then_pass_through`。
- 主题控件不改变位置和样式，只把已有二态能力扩展为浅色、深色、跟随系统。
- 不执行浏览器验收；使用代码层面的定向测试。

## 方案比较

1. 将所有错误直接加入无限期 `transient_retry`：会让认证、权限或参数错误长期挂起，拒绝采用。
2. 为每个新错误增加独立动作策略并复用共享预算：保留可操作性，避免永久错误无限重放，采用。
3. 为每项新增专用的重试次数与退避配置：会增加无必要的设置复杂度，拒绝采用。

## 配置契约

| 字段 | 匹配条件 | 默认值 |
| --- | --- | --- |
| `capacity_error_action` | 既有精确 Capacity 错误 | 保持既有值 |
| `http_429_action` | 既有通用 HTTP 429 | 保持既有值 |
| `model_unavailable_error_action` | JSON `error` 字符串或结构化 `type/code/message` 明确表示模型未配置、不可用或找不到 | `retry_then_pass_through` |
| `http_502_503_error_action` | HTTP 502、503 | `retry_then_pass_through` |
| `other_http_4xx_error_action` | 400-499，排除 429 | `retry_then_pass_through` |
| `other_http_5xx_error_action` | 500-599，排除 502、503 | `retry_then_pass_through` |
| `error_message_fallback_action` | 非空结构化 `error.message`，含 HTTP 200 错误包 | `retry_then_pass_through` |

所有动作只允许 `pass_through`、`return_502`、`retry_then_pass_through`、`retry_then_502`。新增字段缺失时迁移为默认动作，以保证旧配置不需要人工修改。

## 分类与优先级

现有 `transient_retry` 继续优先处理它已识别的可恢复故障，保持其不消耗 `guard_retry_attempts` 的语义。对未被其接管的响应，策略按以下顺序只接管一次：

1. 精确 Capacity
2. 模型未配置/不可用
3. HTTP 429
4. HTTP 502/503
5. 其他 HTTP 4xx
6. 其他 HTTP 5xx
7. 结构化 `error.message` 兜底

模型未配置/不可用是语义错误而不是 HTTP 状态码；它可以出现在 `200`、`4xx` 或 `5xx`。检测仅读取 JSON 的显式 `error` 字符串或对象字段，避免扫描正常响应文本。`error.message` 兜底只接受对象形式的 error envelope，避免误判普通正文。

## 重试与收口

新增策略的 `retry_then_*` 复用已有策略重试延迟和共享 `guard_retry_attempts`。预算耗尽时，`retry_then_pass_through` 返回最后一次上游响应，`retry_then_502` 返回 Gateway 502。仅客户端尚未收到响应头或正文时允许完整重放；已首写的流式响应绝不重放。

## 管理页

在现有“上游错误策略”分组中新增五个下拉框，选项与 Capacity、HTTP 429 完全一致。读取配置、保存配置与控件禁用状态沿用现有表单同步模式。

现有 `.theme-toggle` 控件保持位置与视觉样式。其本地存储值扩展为 `light`、`dark`、`system`；点击循环经过第三种状态。`system` 使用 `matchMedia('(prefers-color-scheme: dark)')` 解析现有 `data-theme`，并监听系统偏好变化。旧的 `light`、`dark` 本地值仍兼容。

## 测试

先在 `scripts/test-gateway-e2e.mjs` 添加失败用例，覆盖：

- 五项字段的默认值、API 保存和管理页下拉契约。
- HTTP 502/503、其他 4xx、其他 5xx 各自的重试和耗尽收口。
- 模型未配置/不可用字符串错误，以及 HTTP 200 的 `error.message` 错误包。
- 已有 Capacity、HTTP 429 与 `transient_retry` 优先级不回归。
- 主题脚本的三态存储、系统偏好解析和事件监听静态/脚本级契约。

随后运行 `build.md` 指定的语法、E2E、安装恢复、Unix 入口、PowerShell AST 与 diff 检查；按用户确认不进行浏览器验收。
