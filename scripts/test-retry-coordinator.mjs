#!/usr/bin/env node

import assert from "node:assert/strict";
import { RetryDispatchCoordinator } from "../retry-coordinator.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

const coordinator = new RetryDispatchCoordinator({ minDispatchIntervalMs: 0 });
const first = await coordinator.acquire("channel\u0000model-a");
assert.equal(first.acquired, true);
const secondPromise = coordinator.acquire("channel\u0000model-a");
const thirdPromise = coordinator.acquire("channel\u0000model-a");
const otherKey = await coordinator.acquire("channel\u0000model-b");
assert.equal(otherKey.acquired, true, "different models must not share a retry lock");
otherKey.release();
assert.equal((await coordinator.snapshot()).queued, 2);
first.release();
const second = await secondPromise;
assert.equal(second.acquired, true, "same-key waiter must be released FIFO");
assert.equal(
  (await coordinator.snapshot()).queued_count,
  1,
  "queued_count must report current queue depth rather than cumulative enqueues",
);
second.release();
const third = await thirdPromise;
assert.equal(third.acquired, true, "second same-key waiter must eventually be released");
third.release();

const abortController = new AbortController();
const held = await coordinator.acquire("channel\u0000model-c");
const cancelledPromise = coordinator.acquire("channel\u0000model-c", {
  signal: abortController.signal,
});
abortController.abort();
const cancelled = await cancelledPromise;
assert.equal(cancelled.acquired, false);
assert.equal(cancelled.reason, "aborted");
held.release();

const deadlineHeld = await coordinator.acquire("channel\u0000model-d");
const deadline = await coordinator.acquire("channel\u0000model-d", {
  deadlineAtMs: Date.now() + 10,
});
assert.equal(deadline.acquired, false);
assert.equal(deadline.reason, "deadline");
deadlineHeld.release();

const heldWithoutForcedExpiry = await coordinator.acquire("channel\u0000model-e");
const waiterWithoutForcedExpiry = coordinator.acquire("channel\u0000model-e");
await new Promise((resolve) => setTimeout(resolve, 130));
assert.equal((await coordinator.snapshot()).active, 1, "a slow attempt must keep its lock");
heldWithoutForcedExpiry.release();
const afterExplicitRelease = await waiterWithoutForcedExpiry;
assert.equal(afterExplicitRelease.acquired, true, "explicit release must advance the queue");
afterExplicitRelease.release();
await tick();
assert.equal((await coordinator.snapshot()).active, 0);
assert.equal((await coordinator.snapshot()).queued, 0);

const cooldownCoordinator = new RetryDispatchCoordinator({ minDispatchIntervalMs: 30 });
const cooldownFirst = await cooldownCoordinator.acquire("channel\u0000model-f");
const cooldownStartedAt = Date.now();
const cooldownSecondPromise = cooldownCoordinator.acquire("channel\u0000model-f");
cooldownFirst.release();
const cooldownSecond = await cooldownSecondPromise;
assert.ok(Date.now() - cooldownStartedAt >= 25, "shared minimum interval must delay the next dispatch");
cooldownSecond.release();

const noQueueCoordinator = new RetryDispatchCoordinator({ minDispatchIntervalMs: 30 });
const noQueueFirst = await noQueueCoordinator.acquire("channel\u0000model-g");
const noQueueStartedAt = Date.now();
noQueueFirst.release();
const noQueueSecond = await noQueueCoordinator.acquire("channel\u0000model-g");
assert.ok(Date.now() - noQueueStartedAt < 25, "没有等待者时不应人为延迟单请求重试");
noQueueSecond.release();

const sharedCooldownCoordinator = new RetryDispatchCoordinator({ minDispatchIntervalMs: 0 });
const sharedCooldownFirst = await sharedCooldownCoordinator.acquire("channel\u0000model-cooldown");
const sharedCooldownStartedAt = Date.now();
const sharedCooldownWaiterPromise = sharedCooldownCoordinator.acquire("channel\u0000model-cooldown");
assert.equal(
  sharedCooldownCoordinator.defer("channel\u0000model-cooldown", Date.now() + 40),
  true,
  "共享冷却必须可以延后同键下一次派发",
);
sharedCooldownFirst.release();
const sharedCooldownWaiter = await sharedCooldownWaiterPromise;
assert.ok(
  Date.now() - sharedCooldownStartedAt >= 35,
  "释放锁不能覆盖上游 Retry-After 共享冷却",
);
sharedCooldownWaiter.release();

const boundedCooldownCoordinator = new RetryDispatchCoordinator({ maxCooldownBuckets: 1 });
assert.equal(
  boundedCooldownCoordinator.defer("channel\u0000model-cooldown-a", Date.now() + 40),
  true,
  "首个共享冷却桶应可建立",
);
assert.equal(
  boundedCooldownCoordinator.defer("channel\u0000model-cooldown-b", Date.now() + 40),
  false,
  "共享冷却桶达到上限时必须降级而不是无限增长",
);
assert.equal(
  boundedCooldownCoordinator.snapshot().cooldown_overflow_count,
  1,
  "共享冷却降级必须可观测",
);

const boundedCoordinator = new RetryDispatchCoordinator({ maxQueuePerKey: 1, maxQueueTotal: 1 });
const boundedHeld = await boundedCoordinator.acquire("channel\u0000model-h");
const boundedWaiter = boundedCoordinator.acquire("channel\u0000model-h");
const boundedOverflow = await boundedCoordinator.acquire("channel\u0000model-h");
assert.equal(boundedOverflow.reason, "overloaded", "队列满时必须快速拒绝而不是无限增长");
boundedHeld.release();
const boundedGranted = await boundedWaiter;
boundedGranted.release();
process.stdout.write("retry coordinator unit tests passed\n");
