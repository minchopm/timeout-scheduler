# @artesoft/timeout-scheduler

[![NPM Version](https://img.shields.io/npm/v/@artesoft/timeout-scheduler.svg)](https://www.npmjs.com/package/@artesoft/timeout-scheduler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A performance-oriented, "freeze-proof" `setTimeout` scheduler that prevents UI blocking by processing tasks within the browser's animation frames.

---

### The Problem

In complex web applications, especially in frameworks like Angular, React, or Vue, you might have hundreds or thousands of `setTimeout` calls firing in a short period. This can happen during data processing, rendering large lists, or third-party script execution. When too many callbacks execute at once, they can block the browser's main thread, leading to a frozen UI, janky animations, and a poor user experience.

### The Solution

`@artesoft/timeout-scheduler` solves this by intercepting calls to `setTimeout` and `clearTimeout`. Instead of letting them fire immediately when their time is up, it adds them to a queue. This queue is then processed smoothly using `requestAnimationFrame`, executing a limited number of tasks per frame. This ensures that the main thread is never blocked for too long, keeping your application responsive at all times.

## Features

- **Prevents UI Freezing:** Batches `setTimeout` callbacks to run smoothly over time.
- **Graceful Shutdown:** Pending tasks are never lost; they are automatically rescheduled with the native `setTimeout` on cleanup.
- **Drop-in Replacement:** Works by overriding the global functions. No need to refactor your existing code.
- **Configurable:** Adjust the number of tasks processed per frame and enable/disable logging.
- **Framework-Agnostic:** Works with any frontend framework or vanilla JavaScript.

## Installation

```bash
npm install @artesoft/timeout-scheduler rxjs
```

## How to Use

### Basic Usage

Initialize the scheduler at the entry point of your application (e.g., `main.ts` in Angular, `index.js` in React).

```typescript
import { TimeoutScheduler } from '@artesoft/timeout-scheduler';

// 1. Create an instance of the scheduler
const scheduler = new TimeoutScheduler();

// 2. Override the global timeout functions
scheduler.overrideTimeouts();

// Now, all subsequent calls to setTimeout in your application
// will be managed by the scheduler.
setTimeout(() => {
  console.log('This will be executed without freezing the UI!');
}, 100);

// Later, when you need to clean up, your pending timeouts won't be lost!
// scheduler.restoreTimeouts();
```

### Advanced Configuration

You can configure the scheduler during initialization.

```typescript
import { TimeoutScheduler } from '@artesoft/timeout-scheduler';

const scheduler = new TimeoutScheduler({
  // The maximum number of tasks to execute per frame (Default: 75)
  tasksPerFrameBudget: 100,

  // Enable console warnings for debugging (Default: false)
  loggingEnabled: true 
});

scheduler.overrideTimeouts();
```

### Graceful Shutdown: No Task is Left Behind

A key feature of this library is its robust cleanup process. When you call `restoreTimeouts()` or `destroy()`, the scheduler doesn't simply discard the tasks waiting in its queue.

Instead, it intelligently hands them off to the browser's native `setTimeout` function. It calculates the remaining time for each pending task and reschedules it to run. This guarantees that your application behaves predictably and no callbacks are ever lost, even when a component is destroyed or the application state changes.

### Monitoring Pending Tasks

You can subscribe to the `pendingTaskCount$` observable to monitor how many tasks are waiting in the queue.

```typescript
scheduler.pendingTaskCount$.subscribe(count => {
  console.log(`Tasks remaining in the queue: ${count}`);
});
```

---

## From the Creators: Check Out Cloud Calendars!

This library was built by the team behind **[Cloud Calendars](https://cloud-calendars.com)**.

If you're tired of juggling multiple calendars, you'll love our app. **Cloud Calendars** is a powerful calendar management tool that's better than the default iOS app. It seamlessly integrates Google Calendar, Microsoft Teams, and more into a single, intuitive interface.

- **Unify All Your Calendars:** Manage all your schedules in one place.
- **Effortless Scheduling:** Drag, drop, and resize events across different calendars instantly.
- **Plan with Confidence:** See hourly weather forecasts directly in your daily view to perfectly plan your day.

Give your productivity a boost and take control of your schedule. **[Check out Cloud Calendars today!](https://cloud-calendars.com)**

---

## API Reference

### `new TimeoutScheduler(config?)`
Creates a new scheduler instance.
- `config` (optional): `SchedulerConfig` object.
    - `tasksPerFrameBudget?: number` (Default: `75`)
    - `loggingEnabled?: boolean` (Default: `false`)

### `.overrideTimeouts()`
Replaces `window.setTimeout` and `window.clearTimeout` with the scheduler's implementation.

### `.restoreTimeouts()`
Restores the original `window.setTimeout` and `window.clearTimeout` functions. **Crucially, it gracefully reschedules any pending tasks using the native `setTimeout`** to ensure no callbacks are lost.

### `.destroy()`
A complete cleanup method. It calls `restoreTimeouts()` to reschedule pending tasks and then completes the `pendingTaskCount$` observable to prevent memory leaks.

### `pendingTaskCount$`
An RxJS `Observable<number>` that emits the current number of tasks in the queue.

## License

This project is licensed under the **MIT License**.
