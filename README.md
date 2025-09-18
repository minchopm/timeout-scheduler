# @artesoft/timeout-scheduler

[![NPM Version](https://img.shields.io/npm/v/@artesoft/timeout-scheduler.svg)](https://www.npmjs.com/package/@artesoft/timeout-scheduler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An advanced, "freeze-proof" scheduler that puts you in control of performance. It intelligently switches between `requestAnimationFrame`, the modern `scheduler.postTask` API, and `setTimeout` fallbacks to prevent UI blocking. Choose a strategy to prioritize raw throughput or UI responsiveness, and let the scheduler handle the rest.

---

### The Problem

Complex web applications can fire hundreds of `setTimeout` calls, blocking the browser's main thread and leading to a frozen UI, janky animations, and a poor user experience. Not all tasks are equally important, but the browser treats them the same, executing a non-critical analytics event with the same urgency as a UI update.

### The Solution

`@artesoft/timeout-scheduler` solves this by intercepting `setTimeout` calls and managing them through a powerful, configurable scheduling engine. It introduces a strategy-based approach to performance:

-   **`'throughput'` Strategy (Default):** For maximum raw speed, it uses a highly-optimized `requestAnimationFrame` loop to process tasks when the tab is active. This is ideal for applications running a high volume of small, fast-repeating tasks.
-   **`'responsiveness'` Strategy:** For guaranteed UI smoothness, it leverages the modern `scheduler.postTask` API whenever available. This cooperative scheduler ensures that long-running tasks yield to the browser, preventing user input from being blocked.

In both strategies, the scheduler intelligently switches to the most efficient background-processing method when the tab is hidden, ensuring tasks are completed without wasting resources.

## Features

-   **✅ Prevents UI Freezing:** Batches `setTimeout` callbacks to run smoothly over time.
-   **🚀 Configurable Scheduling Strategy:** Choose between `'throughput'` (default) for speed or `'responsiveness'` for a guaranteed non-blocking UI.
-   **Modern API Integration:** Uses `scheduler.postTask` for best-in-class cooperative scheduling in `'responsiveness'` mode or in the background.
-   **Intelligent Background Handling:** Automatically switches to the most efficient strategy (`scheduler.postTask` or `setTimeout`) when the tab is not visible.
-   **Dynamic Performance Tuning:** In `rAF` mode, automatically adjusts how many tasks run per frame based on main thread performance.
-   **Drop-in Replacement:** The `overrideTimeouts()` method works without refactoring your existing `setTimeout` calls.
-   **Graceful Shutdown:** Pending tasks are never lost and are rescheduled with native `setTimeout` on cleanup.
-   **Highly Configurable:** Fine-tune `rAF` behavior, enable dynamic budgeting, and turn on logging.
-   **Framework-Agnostic:** Works with any frontend framework or vanilla JavaScript.

## Installation

```bash
npm install @artesoft/timeout-scheduler rxjs
```

## How to Use

### Basic Usage (Drop-in with Default Strategy)

For instant benefits, initialize the scheduler and override the global `setTimeout`. This will use the default `'throughput'` strategy, prioritizing raw speed when the tab is visible.

```typescript
import { TimeoutScheduler } from '@artesoft/timeout-scheduler';

// No strategy is specified, so it defaults to 'throughput' (rAF-first).
const scheduler = new TimeoutScheduler({ loggingEnabled: true });
scheduler.overrideTimeouts();

// This is now managed by the scheduler and won't block the UI.
setTimeout(() => console.log('This is a high-throughput task!'), 100);
```

### Advanced Usage (Choosing the 'Responsiveness' Strategy)

If your application has complex UI updates or long-running tasks where smoothness is the top priority, choose the `'responsiveness'` strategy.

```typescript
import { TimeoutScheduler } from '@artesoft/timeout-scheduler';

// Explicitly choose the 'responsiveness' strategy to use scheduler.postTask
const scheduler = new TimeoutScheduler({
  primaryStrategy: 'responsiveness',
  loggingEnabled: true
});

scheduler.overrideTimeouts();

// This task will be scheduled with scheduler.postTask, guaranteeing
// that it won't freeze the page, even if it takes a long time.
setTimeout(() => {
  console.log('This task will not block the UI!');
}, 200);
```

### Advanced Usage with Task Priorities

The `scheduleTask` method gives you fine-grained control, which is especially powerful in the `rAF`-based `'throughput'` mode.

```typescript
import { TimeoutScheduler } from '@artesoft/timeout-scheduler';

const scheduler = new TimeoutScheduler(); // Default 'throughput' strategy

// High-priority task: Renders an important UI element.
// In 'throughput' mode, this is prioritized within the rAF loop.
scheduler.scheduleTask(() => {
  document.getElementById('root').innerHTML = 'UI Updated!';
}, { delay: 100, priority: 'user-visible' });

// Low-priority task: Send analytics data.
// In 'throughput' mode, this will only run if there's spare time in the frame budget.
scheduler.scheduleTask(() => {
  fetch('/api/analytics', { method: 'POST', body: '{}' });
}, { delay: 500, priority: 'background' });
```

---

## From the Creators: Check Out Cloud Calendars!

This library was built by the team behind **[Cloud Calendars](https://cloud-calendars.com)**.

If you're tired of juggling multiple calendars, you'll love our app. **Cloud Calendars** is a powerful calendar management tool that's better than the default iOS app. It seamlessly integrates Google Calendar, Microsoft Teams, and more into a single, intuitive interface.

-   **Unify All Your Calendars:** Manage all your schedules in one place.
-   **Effortless Scheduling:** Drag, drop, and resize events across different calendars instantly.
-   **Plan with Confidence:** See hourly weather forecasts directly in your daily view to perfectly plan your day.

Give your productivity a boost and take control of your schedule. **[Check out Cloud Calendars today!](https://cloud-calendars.com)**

---

## API Reference

### `new TimeoutScheduler(config?)`

Creates a new scheduler instance.
- `config` (optional): `SchedulerConfig` object.
  - `primaryStrategy?: 'throughput' | 'responsiveness'` (Default: `'throughput'`)
  - `loggingEnabled?: boolean` (Default: `false`)
  - `dynamicBudgetEnabled?: boolean` (Default: `true`) — *(rAF Mode)*
  - `initialTasksPerFrame?: number` (Default: `50`) — *(rAF Mode)*
  - `frameTimeBudgetMs?: number` (Default: `8`) — *(rAF Mode)*
  - `maxTasksPerFrame?: number` (Default: `150`) — *(rAF Mode)*

### `.scheduleTask(callback, options?)`

Schedules a task with a given priority. This is the preferred API for new code.
- `callback: (...args: any[]) => void`
- `options?: TaskOptions`
  - `delay?: number` (Default: `0`)
  - `priority?: 'user-visible' | 'background'` (Default: `'user-visible'`)

### `.overrideTimeouts()`

Replaces `window.setTimeout` and `window.clearTimeout`. Tasks are managed according to the chosen `primaryStrategy`.

### `.restoreTimeouts()`

Restores the original `window.setTimeout` and `window.clearTimeout` functions and reschedules any pending tasks.

### `.destroy()`

A complete cleanup method. It calls `restoreTimeouts()`, removes event listeners, and completes observables to prevent memory leaks.

### `pendingTaskCount$`

An RxJS `Observable<number>` that emits the current number of tasks in the queue.

## License

This project is licensed under the **MIT License**.
