# @artesoft/timeout-scheduler

[![NPM Version](https://img.shields.io/npm/v/@artesoft/timeout-scheduler.svg)](https://www.npmjs.com/package/@artesoft/timeout-scheduler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An advanced, "freeze-proof" scheduler that puts you in control of performance. It intelligently switches between `requestAnimationFrame`, the modern `scheduler.postTask` API, and `setTimeout` fallbacks to prevent UI blocking. Choose a strategy to prioritize raw throughput or UI responsiveness, and let the scheduler handle the rest.

---

### The Problem

Complex web applications can fire hundreds of `setTimeout` calls, blocking the browser's main thread and leading to a frozen UI, janky animations, and a poor user experience. Not all tasks are equally important, but the browser treats them the same, executing a non-critical analytics event with the same urgency as a UI update. Furthermore, relying on global overrides often breaks real-time networking libraries (like Socket.io) which depend on precise timing.

### The Solution

`@artesoft/timeout-scheduler` solves this by intercepting `setTimeout` calls and managing them through a powerful, configurable scheduling engine. It introduces a strategy-based approach to performance:

-   **`'throughput'` Strategy (Default):** For maximum raw speed, it uses a highly-optimized `requestAnimationFrame` loop to process tasks when the tab is active. Ideal for high-frequency UI updates.
-   **`'responsiveness'` Strategy:** For guaranteed UI smoothness, it leverages the modern `scheduler.postTask` API whenever available to yield to the main thread frequently.

Crucially, it now supports **Selective Batching**, allowing you to let specific critical tasks (like network heartbeats) bypass the scheduler entirely for exact timing, while the rest of your app remains optimized.

## Features

-   **✅ Prevents UI Freezing:** Batches `setTimeout` callbacks to run smoothly over time using frame budgeting.
-   **🔌 Networking Friendly:** New **Batching Opt-Out** feature allows Socket.io and other real-time libraries to bypass the scheduler for precise timing, preventing connection drops.
-   **🚀 Configurable Scheduling Strategy:** Choose between `'throughput'` (default) for speed or `'responsiveness'` for a guaranteed non-blocking UI.
-   **Modern API Integration:** Uses `scheduler.postTask` for best-in-class cooperative scheduling where available.
-   **Intelligent Background Handling:** Automatically switches strategies when the tab is hidden to save resources.
-   **🔋 Background CPU Control:** Configurable background tick interval allows you to trade off between background responsiveness and battery usage.
-   **Dynamic Performance Tuning:** In `rAF` mode, automatically adjusts how many tasks run per frame based on actual execution time.
-   **Drop-in Replacement:** The `overrideTimeouts()` method works without refactoring your existing `setTimeout` calls.
-   **Graceful Shutdown:** Pending tasks are never lost and are rescheduled with native `setTimeout` on cleanup.

## Installation

```bash
npm install @artesoft/timeout-scheduler rxjs
```

## How to Use

### 1. Basic Usage (Drop-in)

For instant benefits, initialize the scheduler and override the global `setTimeout`. This uses the default `'throughput'` strategy.

```typescript
import { TimeoutScheduler } from '@artesoft/timeout-scheduler';

const scheduler = new TimeoutScheduler({ loggingEnabled: true });
scheduler.overrideTimeouts();

// This is now managed by the scheduler and won't block the UI.
setTimeout(() => console.log('This is a high-throughput task!'), 100);
```

### 2. Handling WebSockets / Socket.io (New)

Real-time libraries like Socket.io rely on precise timers for heartbeats. If these are batched or throttled in background tabs, connections may drop. You can use the `getTaskOptions` hook to **exclude** these libraries from the scheduler dynamically.

```typescript
scheduler.overrideTimeouts({
  // This function runs for every setTimeout call
  getTaskOptions: (callback, delay, args) => {
    const stack = new Error().stack || '';

    // If the call originates from Socket.io or Engine.io, disable batching.
    // It will run instantly via a native browser timer.
    if (stack.includes('socket.io') || stack.includes('engine.io')) {
      return { batching: false };
    }
    
    // (Optional) Heuristic: lengthy delays are likely not UI related
    if (delay > 2000) {
       return { batching: false };
    }

    // Default: Manage this task in the scheduler
    return { batching: true };
  }
});
```

### 3. Prioritizing UI Responsiveness

If your application has complex UI updates where smoothness is the top priority, choose the `'responsiveness'` strategy.

```typescript
const scheduler = new TimeoutScheduler({
  primaryStrategy: 'responsiveness'
});
scheduler.overrideTimeouts();
```

### 4. Controlling Background CPU Usage

By default, the scheduler ticks every 250ms when the tab is hidden. You can increase this to save battery or decrease it if your background tasks need to run faster.

```typescript
const scheduler = new TimeoutScheduler({
  // Run background checks only once every second to save battery
  backgroundTickInterval: 1000 
});
```

### 5. Manual Scheduling

You can also schedule tasks directly without overriding the global `setTimeout`.

```typescript
// High-priority task: Renders an important UI element.
scheduler.scheduleTask(() => {
  updateUI();
}, { delay: 100, priority: 'user-visible' });

// Low-priority task: Analytics
scheduler.scheduleTask(() => {
  sendAnalytics();
}, { delay: 500, priority: 'background' });

// Exact timing task: Bypasses the frame loop entirely
scheduler.scheduleTask(() => {
  pingServer();
}, { delay: 1000, batching: false });
```

---

## API Reference

### `new TimeoutScheduler(config?)`

Creates a new scheduler instance.
- `config` (optional): `SchedulerConfig` object.
  - `primaryStrategy?: 'throughput' | 'responsiveness'` (Default: `'throughput'`)
  - `backgroundTickInterval?: number` (Default: `250`) — Interval in ms for the background loop when tab is hidden.
  - `loggingEnabled?: boolean` (Default: `false`)
  - `dynamicBudgetEnabled?: boolean` (Default: `true`) — *(rAF Mode)*
  - `frameTimeBudgetMs?: number` (Default: `8`) — *(rAF Mode)*
  - `initialTasksPerFrame?: number` (Default: `50`) — *(rAF Mode)*
  - `maxTasksPerFrame?: number` (Default: `150`) — *(rAF Mode)*

### `.overrideTimeouts(options?)`

Replaces `window.setTimeout` and `window.clearTimeout`.
- `options?`: `OverrideOptions` object.
  - `getTaskOptions?: (callback, delay, args) => TaskOptions`: A hook to determine options per call. Use this to return `{ batching: false }` for specific libraries.

### `.scheduleTask(callback, options?)`

Schedules a task. Returns a task ID.
- `callback: (...args: any[]) => void`
- `options?: TaskOptions`
  - `delay?: number` (Default: `0`)
  - `priority?: 'user-visible' | 'background'` (Default: `'user-visible'`)
  - `batching?: boolean` (Default: `true`) — If `false`, schedules a native timer immediately, bypassing the scheduler logic.

### `.restoreTimeouts()`

Restores the original `window.setTimeout` and `window.clearTimeout` functions and reschedules any pending batched tasks to run natively.

### `.destroy()`

A complete cleanup method. It calls `restoreTimeouts()`, removes event listeners, and completes observables.

### `pendingTaskCount$`

An RxJS `Observable<number>` that emits the current number of tasks in the queue.

## License

This project is licensed under the **MIT License**.
