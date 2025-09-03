// src/index.ts

import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Configuration options for the TimeoutScheduler.
 */
export interface SchedulerConfig {
    /**
     * The maximum number of tasks to execute per animation frame.
     * Helps prevent UI blocking by spreading work over time.
     * @default 75
     */
    tasksPerFrameBudget?: number;
    /**
     * Whether to enable console warnings when overriding and restoring timeouts.
     * Useful for debugging, but should be disabled in production.
     * @default false
     */
    loggingEnabled?: boolean;
}

/**
 * An internal interface representing a scheduled task.
 */
interface ScheduledTask {
    id: number;
    callback: (...args: any[]) => void;
    executeAt: number;
}

export class TimeoutScheduler {
    private readonly tasksPerFrameBudget: number;
    private readonly loggingEnabled: boolean;

    private readonly originalSetTimeout = window.setTimeout;
    private readonly originalClearTimeout = window.clearTimeout;

    private isOverridden = false;
    private isTicking = false;
    private taskIdCounter = 0;
    private animationFrameId = 0;

    private taskQueue = new Map<number, ScheduledTask>();

    private pendingTaskCountSubject = new BehaviorSubject<number>(0);
    public readonly pendingTaskCount$: Observable<number> = this.pendingTaskCountSubject.asObservable();

    /**
     * Constructs an instance of TimeoutScheduler.
     * @param config Optional configuration for the scheduler.
     */
    constructor(config?: SchedulerConfig) {
        this.tasksPerFrameBudget = config?.tasksPerFrameBudget ?? 75;
        this.loggingEnabled = config?.loggingEnabled ?? false;

        if (typeof window === 'undefined' || typeof window.requestAnimationFrame === 'undefined') {
            throw new Error('TimeoutScheduler can only run in a browser environment with requestAnimationFrame support.');
        }
    }

    /**
     * Overrides the global `window.setTimeout` and `window.clearTimeout`
     * with the scheduler's own implementations to manage task execution
     * within animation frames, preventing UI freezes.
     */
    public overrideTimeouts(): void {
        if (this.isOverridden) { return; }
        if (this.loggingEnabled) {
            console.warn('--- TimeoutScheduler: OVERRIDING global setTimeout for performance. ---');
        }
        this.isOverridden = true;

        window.setTimeout = ((callback: (...args: any[]) => void, delay?: number): number => {
            const taskId = ++this.taskIdCounter;
            const executeAt = Date.now() + (delay || 0);

            this.taskQueue.set(taskId, { id: taskId, callback, executeAt });
            this.pendingTaskCountSubject.next(this.taskQueue.size);

            if (!this.isTicking) {
                this.startTicker();
            }
            return taskId;
        }) as any;

        window.clearTimeout = ((timeoutId?: number): void => {
            if (timeoutId === undefined) { return; }

            if (this.taskQueue.delete(timeoutId)) {
                this.pendingTaskCountSubject.next(this.taskQueue.size);
            } else {
                this.originalClearTimeout.apply(window, [timeoutId]);
            }
        }) as any;
    }

    /**
     * Restores the original timeout functions. Instead of discarding pending
     * tasks, it gracefully reschedules them using the native `setTimeout`
     * with their remaining time.
     */
    public restoreTimeouts(): void {
        if (!this.isOverridden) { return; }
        if (this.loggingEnabled) {
            console.warn('--- TimeoutScheduler: Restoring original functions and rescheduling pending tasks. ---');
        }

        this.stopTicker();

        // CRITICAL: Restore the original functions BEFORE rescheduling.
        window.setTimeout = this.originalSetTimeout;
        window.clearTimeout = this.originalClearTimeout;
        this.isOverridden = false;

        const now = Date.now();

        // Reschedule all pending tasks with the native setTimeout.
        for (const task of this.taskQueue.values()) {
            const remainingDelay = task.executeAt - now;
            const finalDelay = Math.max(0, remainingDelay); // Ensure delay is not negative.
            this.originalSetTimeout(task.callback, finalDelay);
        }

        // Clear the internal queue now that tasks have been handed off.
        this.taskQueue.clear();
        this.pendingTaskCountSubject.next(0);
    }

    private startTicker(): void {
        if (this.isTicking) { return; }
        this.isTicking = true;
        this.animationFrameId = window.requestAnimationFrame(this.tick);
    }

    private stopTicker(): void {
        if (!this.isTicking) { return; }
        window.cancelAnimationFrame(this.animationFrameId);
        this.isTicking = false;
    }

    private tick = (): void => {
        if (!this.isTicking) { return; }

        const now = Date.now();
        let tasksExecutedThisFrame = 0;

        for (const task of this.taskQueue.values()) {
            if (tasksExecutedThisFrame >= this.tasksPerFrameBudget) {
                break;
            }
            if (task.executeAt <= now) {
                try {
                    task.callback();
                } catch (e) {
                    console.error('Error executing scheduled callback:', e, task);
                }
                this.taskQueue.delete(task.id);
                tasksExecutedThisFrame++;
            }
        }

        this.pendingTaskCountSubject.next(this.taskQueue.size);

        if (this.taskQueue.size > 0) {
            this.animationFrameId = window.requestAnimationFrame(this.tick);
        } else {
            this.stopTicker();
        }
    }

    /**
     * Cleans up the scheduler. It gracefully restores original timeouts
     * and completes the pendingTaskCount$ observable.
     */
    public destroy(): void {
        this.restoreTimeouts();
        this.pendingTaskCountSubject.complete();
    }
}
