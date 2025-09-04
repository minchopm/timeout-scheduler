import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Defines the configuration options for the TimeoutScheduler.
 */
export interface SchedulerConfig {
    /**
     * The maximum number of tasks to execute per animation frame. This budget
     * prevents the main thread from blocking and keeps the UI responsive.
     * @default 75
     */
    tasksPerFrameBudget?: number;

    /**
     * If true, the scheduler will log warnings to the console when it overrides
     * and restores the global timeout functions. Recommended for debugging.
     * @default false
     */
    loggingEnabled?: boolean;
}

/**
 * @internal
 * An internal interface representing a task scheduled to be executed.
 */
interface ScheduledTask {
    /** A unique identifier for the task. */
    id: number;
    /** The callback function to execute. */
    callback: (...args: any[]) => void;
    /** The UNIX timestamp (in ms) when the task should be executed. */
    executeAt: number;
    /** An array of arguments to pass to the callback function upon execution. */
    args: any[];
}

/**
 * A performance-oriented scheduler that overrides `setTimeout` to prevent UI
 * blocking. It intercepts calls, queues them, and processes the queue in small
 * batches using `requestAnimationFrame`, ensuring a smooth and responsive user experience.
 */
export class TimeoutScheduler {
    // --- Private Properties ---

    private readonly tasksPerFrameBudget: number;
    private readonly loggingEnabled: boolean;

    // We provide a more accurate type signature for setTimeout to satisfy TypeScript,
    // as the default one doesn't account for additional arguments.
    private readonly originalSetTimeout: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => number = window.setTimeout;
    private readonly originalClearTimeout = window.clearTimeout;

    private isOverridden = false;
    private isTicking = false;
    private taskIdCounter = 0;
    private animationFrameId = 0;

    // The main queue where tasks are stored before execution.
    private taskQueue = new Map<number, ScheduledTask>();

    // --- Public Properties ---

    private readonly pendingTaskCountSubject = new BehaviorSubject<number>(0);
    /**
     * An RxJS Observable that emits the number of pending tasks in the queue.
     * This can be used to monitor the scheduler's workload.
     */
    public readonly pendingTaskCount$: Observable<number> = this.pendingTaskCountSubject.asObservable();

    /**
     * Constructs an instance of the TimeoutScheduler.
     * @param config Optional configuration to customize the scheduler's behavior.
     */
    constructor(config?: SchedulerConfig) {
        // Set properties from config, falling back to sensible defaults.
        this.tasksPerFrameBudget = config?.tasksPerFrameBudget ?? 75;
        this.loggingEnabled = config?.loggingEnabled ?? false;

        // This scheduler relies on browser APIs, so we ensure it's not run in a non-browser environment.
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame === 'undefined') {
            throw new Error('TimeoutScheduler can only run in a browser environment with requestAnimationFrame support.');
        }
    }

    /**
     * Overrides the global `window.setTimeout` and `window.clearTimeout` functions.
     */
    public overrideTimeouts(): void {
        if (this.isOverridden) { return; }
        if (this.loggingEnabled) {
            console.warn('--- TimeoutScheduler: OVERRIDING global setTimeout for performance. ---');
        }
        this.isOverridden = true;

        // Override setTimeout to capture the callback, delay, and any additional arguments.
        window.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]): number => {
            const taskId = ++this.taskIdCounter;
            const executeAt = Date.now() + (delay || 0);

            this.taskQueue.set(taskId, { id: taskId, callback, executeAt, args });
            this.pendingTaskCountSubject.next(this.taskQueue.size);

            if (!this.isTicking) {
                this.startTicker();
            }
            return taskId;
        }) as any;

        // Override clearTimeout to remove tasks from our queue.
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
     * Restores the original `window.setTimeout` and `window.clearTimeout` functions.
     */
    public restoreTimeouts(): void {
        if (!this.isOverridden) { return; }
        if (this.loggingEnabled) {
            console.warn('--- TimeoutScheduler: Restoring original functions and rescheduling pending tasks. ---');
        }

        this.stopTicker();

        // Use a type assertion (as any) to bypass the strict type checking issue caused by
        // conflicting Node.js and browser type definitions for setTimeout.
        window.setTimeout = this.originalSetTimeout as any;
        window.clearTimeout = this.originalClearTimeout;
        this.isOverridden = false;

        const now = Date.now();

        // Iterate over any remaining tasks and reschedule them with the native setTimeout.
        for (const task of this.taskQueue.values()) {
            const remainingDelay = Math.max(0, task.executeAt - now);
            this.originalSetTimeout.apply(window, [task.callback, remainingDelay, ...task.args]);
        }

        // Clear the internal queue as all tasks have been handed off.
        this.taskQueue.clear();
        this.pendingTaskCountSubject.next(0);
    }

    /**
     * Starts the `requestAnimationFrame` loop if it's not already running.
     */
    private startTicker(): void {
        if (this.isTicking) { return; }
        this.isTicking = true;
        this.animationFrameId = window.requestAnimationFrame(this.tick);
    }

    /**
     * Stops the `requestAnimationFrame` loop.
     */
    private stopTicker(): void {
        if (!this.isTicking) { return; }
        window.cancelAnimationFrame(this.animationFrameId);
        this.isTicking = false;
    }

    /**
     * The main processing loop, executed on each animation frame.
     */
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
                    task.callback(...task.args);
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
     * A final cleanup method.
     */
    public destroy(): void {
        this.restoreTimeouts();
        this.pendingTaskCountSubject.complete();
    }
}
