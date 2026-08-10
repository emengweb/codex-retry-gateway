# Upstream Error Policies and System Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Track the checklist below as work progresses.

**Goal:** Retain existing Capacity and HTTP 429 policies, add five independently configurable retry policies for upstream failures, and extend the existing theme control with a follow-system mode without changing its placement or visual style.

**Architecture:** Keep all policy actions on the existing four-action contract and classify a response only after the current transient retry path has declined it. Centralize structured-error extraction so HTTP responses and SSE terminal error events follow the same policy precedence. Persist the new fields through the existing config normalization and management API. Extend the existing inline theme state from two explicit values to `light`, `dark`, and `system`, while continuing to set only the resolved light/dark value on the document.

**Tech Stack:** Node.js HTTP gateway, SSE proxying, inline HTML/CSS/JavaScript management UI, Node E2E tests.

---

## Scope and Safety Rules

- Preserve the existing Capacity and HTTP 429 switches, defaults, labels, and matching behavior.
- New policies default to `retry_then_pass_through` and share the existing retry-attempt budget and retry delay policy.
- Do not replay an upstream request after client headers or body have been written.
- Preserve transient retry precedence. The new policies run only when transient classification has not requested a retry.
- Keep the current theme button's markup position and CSS class/style. Its click behavior becomes `light -> dark -> system -> light`.
- Run code-level checks only. Do not start, restart, or replace the gateway at `127.0.0.1:4610`, and do not perform browser validation.
- This worktree already contains user changes in shared files. Do not reset, discard, or broadly stage those changes.

## Policy Contract

All policy fields use one existing action value:

```js
pass_through
return_502
retry_then_pass_through
retry_then_502
```

Add these config fields, each defaulting to `retry_then_pass_through`:

```js
model_unavailable_error_action
http_502_503_error_action
other_http_4xx_error_action
other_http_5xx_error_action
error_message_fallback_action
```

Classification precedence after transient retry declines the response:

1. Existing exact Capacity detection.
2. Model unconfigured or unavailable semantic error detection.
3. Existing HTTP 429 detection.
4. HTTP 502 or 503.
5. Other HTTP 4xx, excluding 429.
6. Other HTTP 5xx, excluding 502 and 503.
7. Structured `error.message` fallback, including a 200 error envelope.

## Task 1: Establish Config and Management UI Contract

**Files:**
- Modify: `scripts/test-gateway-e2e.mjs`
- Modify: `gateway.mjs`
- Modify: `config.example.json`

- [ ] Add E2E assertions that a clean gateway configuration returns the five new policy fields with `retry_then_pass_through` defaults.
- [ ] Add static management-page assertions for five selectors in the existing `上游错误策略` group and for the existing four action values in each selector.
- [ ] Add a management API save/load round-trip assertion that changes all five policy fields and verifies they persist in the returned configuration.
- [ ] Run `node scripts/test-gateway-e2e.mjs` and confirm the new assertions fail before modifying gateway production code.
- [ ] Add the five defaults to `DEFAULT_CONFIG` in `gateway.mjs`.
- [ ] Normalize each new field in `loadConfig` with `normalizeUpstreamErrorAction`, matching the existing Capacity and HTTP 429 handling.
- [ ] Read and accept each new policy from `buildEditableConfig`, preserving the existing request validation and field naming style.
- [ ] Add five corresponding dropdowns to the existing `上游错误策略` section; do not alter the existing Capacity or HTTP 429 dropdowns.
- [ ] Add form references, form population, payload serialization, and summary rendering for the new controls.
- [ ] Document the defaults in `config.example.json`.
- [ ] Re-run `node scripts/test-gateway-e2e.mjs` and confirm the Task 1 contract is green.

## Task 2: Add Non-Streaming Upstream Error Policy Classification

**Files:**
- Modify: `scripts/test-gateway-e2e.mjs`
- Modify: `gateway.mjs`

- [ ] Extend the fake upstream in the E2E test with a deterministic response-sequence fixture: it returns a configured structured error for a fixed number of attempts, then a normal completion.
- [ ] Add failing E2E cases that prove each policy retries once under its default action:
  - model unavailable using `{"error":"模型 'gpt-5.6-sol' 未配置或不可用"}`;
  - HTTP 502 and HTTP 503;
  - a representative non-429 4xx status;
  - a representative non-502/503 5xx status;
  - a 200 structured `{"error":{"message":"代理返回了未分类错误"}}` envelope.
- [ ] Add failing E2E cases that prove HTTP 429 does not use the other-4xx policy and that a disabled semantic fallback passes through without replaying.
- [ ] Run `node scripts/test-gateway-e2e.mjs` and confirm the policy assertions fail before modifying production classification.
- [ ] Add a small structured-error extraction helper near the existing upstream error classifiers. It must safely identify `error` strings and `error.message` objects without treating normal successful payloads as errors.
- [ ] Add a model-unavailable matcher for explicit Chinese and English configuration/unavailability wording, including the confirmed Chinese example. Keep the matcher scoped to an actual structured error envelope.
- [ ] Extend `classifyUpstreamErrorPolicy` with the five new branches in the documented precedence order, excluding 429 from other-4xx and 502/503 from other-5xx.
- [ ] Reuse `actionRequestsRetry`, `guard_retry_attempts`, and `resolveUpstreamPolicyRetryDelay`; do not create a second retry counter or delay system.
- [ ] Keep the existing transient response classifier ahead of the policy classifier in the non-streaming retry loop.
- [ ] Re-run `node scripts/test-gateway-e2e.mjs` and confirm all non-streaming policy tests are green.

## Task 3: Apply the Same Policy Contract to Streaming Failures

**Files:**
- Modify: `scripts/test-gateway-e2e.mjs`
- Modify: `gateway.mjs`

- [ ] Add a failing SSE E2E fixture that emits a structured terminal error envelope before sending client-visible data, then succeeds on the retry attempt.
- [ ] Add a failing E2E assertion that a configured model-unavailable stream error retries once and completes, while preserving the existing no-replay-after-output guard.
- [ ] Run `node scripts/test-gateway-e2e.mjs` and confirm the new streaming case fails before modifying production stream handling.
- [ ] Feed extracted terminal stream error information into the same upstream-policy classifier, with the existing transient stream classifier retaining first priority.
- [ ] Ensure a stream can retry only before response headers or SSE body content reach the client; otherwise leave the existing failure behavior intact.
- [ ] Re-run `node scripts/test-gateway-e2e.mjs` and confirm streaming and non-streaming policy cases are green.

## Task 4: Extend the Existing Theme Control With Follow-System Mode

**Files:**
- Modify: `scripts/test-gateway-e2e.mjs`
- Modify: `gateway.mjs`

- [ ] Add static management-page E2E assertions for the `system` theme mode, a system color-scheme media query, and a change listener that updates the resolved document theme.
- [ ] Run `node scripts/test-gateway-e2e.mjs` and confirm the new theme assertions fail before production changes.
- [ ] Keep `.theme-toggle`, `#themeToggleButton`, and its position/style unchanged.
- [ ] Update the inline theme state to accept persisted `light`, `dark`, and `system` values, retaining compatibility with existing light/dark preferences.
- [ ] Resolve `system` through `window.matchMedia('(prefers-color-scheme: dark)')`, set `data-theme` only to the resolved `light` or `dark` value, and update the existing label and accessible name to indicate the next mode.
- [ ] Add a media-query change listener that reapplies the resolved theme only while the saved preference remains `system`.
- [ ] Cycle the existing button click through `light`, `dark`, and `system` without moving or restyling the control.
- [ ] Re-run `node scripts/test-gateway-e2e.mjs` and confirm the theme contract is green.

## Task 5: Documentation, Regression Record, and Verification

**Files:**
- Modify: `README.md`
- Modify: `config.example.json`
- Modify: `err.md`
- Modify: `.tasks/2026-08-11-upstream-error-policy-and-system-theme/{PROGRESS.md,ACCEPTANCE.md,FINAL.md,TODO.md}`

- [ ] Document all five new upstream policy fields, their defaults, action meanings, exclusions, and retry precedence in `README.md`.
- [ ] Verify `config.example.json` matches runtime defaults exactly.
- [ ] Record the root cause, minimal fix, and regression command in `err.md`.
- [ ] Update task tracking with actual test results and note that browser validation was intentionally skipped at the user's direction.
- [ ] Run the build-mandated Node verification serially:

```sh
node scripts/test-gateway-e2e.mjs
node scripts/test-install-restore.mjs
node scripts/test-launch-ui.mjs
node scripts/test-launch-ui-unix.mjs
node --check gateway.mjs
node --check scripts/admin-lib.mjs
node --check scripts/test-gateway-e2e.mjs
node --check scripts/test-install-restore.mjs
node --check scripts/test-launch-ui.mjs
node --check scripts/test-launch-ui-unix.mjs
git diff --check
```

- [ ] Run the PowerShell parse/lifecycle validation specified in `build.md` when `pwsh` is available; report any unavailable dependency explicitly.
- [ ] Run the advanced UI release snapshot command and compare it with the captured snapshot. Record any unavoidable tool/version difference in the task finalization note.
- [ ] Inspect `git diff` and `git status --short`; do not reset or stage unrelated user changes. Commit only files that can be attributed solely to this task, otherwise report the shared dirty-worktree limitation.

## Final Review Checklist

- [ ] Existing Capacity and HTTP 429 UI controls and runtime behavior remain present.
- [ ] Every new policy is independently configurable and defaults to internal retry then pass-through.
- [ ] Policy categories do not overlap incorrectly: 429 is not other-4xx; 502/503 are not other-5xx.
- [ ] Structured `error.message` fallback never matches a normal successful payload.
- [ ] Existing transient retry keeps priority and all retries honor the existing attempt budget.
- [ ] The system theme option retains old preferences, responds to OS changes, and changes neither the control location nor its CSS styling.
- [ ] No browser test or gateway restart was performed.
