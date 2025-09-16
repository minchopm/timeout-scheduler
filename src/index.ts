import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Defines the priority of a task, determining when it should be executed.
 * - `user-visible`: High priority. The task is important for the user experience and
 *   should run as soon as possible. Uses `requestAnimationFrame`.
 * - `background`: Low priority. The task is non-essential and can be deferred until
 *   the browser is idle. Uses `requestIdleCallback`.
 */
export type TaskPriority = 'user-visible' | 'background';

/**
 * Defines the options for scheduling a task with priority.
 */
export interface TaskOptions {
    /** The delay in milliseconds before the task should be executed. */
    delay?: number;
    /** The priority of the task, affecting which scheduling mechanism is used. */
    priority?: TaskPriority;
}

/**
 * Defines the configuration options for the TimeoutScheduler.
 */
export interface SchedulerConfig {
    /**
     * The initial number of tasks to execute per frame. This value will be
     * dynamically adjusted if `dynamicBudgetEnabled` is true.
     * @default 50
     */
    initialTasksPerFrame?: number;
    /**
     * If true, the scheduler will log its status and budget adjustments to the console.
     * @default false
     */
    loggingEnabled?: boolean;
    /**
     * If true, the scheduler will switch to a `setInterval` ticker when the page is
     * hidden to ensure tasks continue to execute in the background.
     * @default false
     */
    runInBackground?: boolean;
    /**
     * If true, enables the dynamic adjustment of the tasks-per-frame budget
     * based on the main thread's performance.
     * @default true
     */
    dynamicBudgetEnabled?: boolean;
    /**
     * The target frame processing time in milliseconds. If a frame's work exceeds
     * this budget, the scheduler will reduce its workload for subsequent frames.
     * @default 8
     */
    frameTimeBudgetMs?: number;
    /**
     * The maximum number of tasks the scheduler is allowed to execute in a
     * single frame, preventing the dynamic budget from growing indefinitely.
     * @default 150
     */
    maxTasksPerFrame?: number;
}

/**
 * @internal The interval (in ms) for the less frequent background ticker.
 */
const BACKGROUND_TICK_INTERVAL_MS = 250;

/**
 * @internal An internal interface representing a task in the queue.
 */
interface ScheduledTask {
    id: number;
    callback: (...args: any[]) => void;
    executeAt: number;
    args: any[];
    priority: TaskPriority;
}

/**
 * A performance-oriented scheduler that overrides `setTimeout` and provides a
 * priority-based task scheduling system. It uses `requestAnimationFrame` for
 * high-priority work and `requestIdleCallback` for background tasks to ensure
 * a smooth user experience.
 */
export class TimeoutScheduler {
    // --- Configuration ---
    private readonly loggingEnabled: boolean;
    private readonly runInBackground: boolean;
    private readonly dynamicBudgetEnabled: boolean;
    private readonly frameTimeBudgetMs: number;
    private readonly maxTasksPerFrame: number;
    private readonly initialTasksPerFrame: number;

    // --- Native Functions ---
    private readonly originalSetTimeout = window.setTimeout;
    private readonly originalClearTimeout = window.clearTimeout;

    // --- State ---
    private isOverridden = false;
    private taskIdCounter = 0;
    private currentTasksPerFrame: number;
    private taskQueue = new Map<number, ScheduledTask>();

    // --- Ticker Management ---
    private animationFrameId = 0;
    private backgroundTickerId: number | null = null;
    private idleCallbackId = 0;
    private activeTicker: 'rAF' | 'rIC' | 'interval' | 'none' = 'none';

    // --- Public Observables ---

    /** An RxJS Observable that emits the current number of tasks pending in the queue. */
    public readonly pendingTaskCount$: Observable<number>;
    private readonly pendingTaskCountSubject = new BehaviorSubject<number>(0);

    /**
     * Constructs an instance of the TimeoutScheduler.
     * @param config Optional configuration to customize the scheduler's behavior.
     */
    constructor(config?: SchedulerConfig) {
        this.pendingTaskCount$ = this.pendingTaskCountSubject.asObservable();

        this.loggingEnabled = config?.loggingEnabled ?? false;
        this.runInBackground = config?.runInBackground ?? false;
        this.dynamicBudgetEnabled = config?.dynamicBudgetEnabled ?? true;
        this.frameTimeBudgetMs = config?.frameTimeBudgetMs ?? 8;
        this.initialTasksPerFrame = config?.initialTasksPerFrame ?? 50;
        this.maxTasksPerFrame = config?.maxTasksPerFrame ?? 150;
        this.currentTasksPerFrame = this.initialTasksPerFrame;

        if (typeof window === 'undefined' || !window.requestAnimationFrame || !window.performance) {
            throw new Error('TimeoutScheduler requires a browser environment with requestAnimationFrame and performance API support.');
        }

        if (this.runInBackground && typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.handleVisibilityChange);
        }
    }

    /**
     * Schedules a task with a specific priority. This is the recommended way to
     * leverage the scheduler's cooperative scheduling capabilities.
     * @param callback The function to execute.
     * @param options The scheduling options, including delay and priority.
     * @returns The ID of the scheduled task, which can be used for cancellation.
     */
    public scheduleTask(callback: (...args: any[]) => void, options?: TaskOptions): number {
        const taskId = ++this.taskIdCounter;
        const priority = options?.priority ?? 'user-visible';
        const executeAt = performance.now() + (options?.delay ?? 0);

        this.taskQueue.set(taskId, { id: taskId, callback, executeAt, args: [], priority });
        this.pendingTaskCountSubject.next(this.taskQueue.size);

        if (this.activeTicker === 'none') {
            this.startTicker();
        } else if (priority === 'user-visible' && this.activeTicker === 'rIC') {
            if (this.loggingEnabled) {
                console.warn('--- TimeoutScheduler: High priority task added. Switching from rIC to rAF. ---');
            }
            this.stopTicker();
            this.startTicker();
        }

        return taskId;
    }

    /**
     * Overrides the global `window.setTimeout` and `window.clearTimeout` functions.
     * All tasks scheduled via the global `setTimeout` will be treated as 'user-visible' priority.
     */
    public overrideTimeouts(): void {
        if (this.isOverridden) { return; }
        if (this.loggingEnabled) {
            console.warn('--- TimeoutScheduler: OVERRIDING global setTimeout for performance. ---');
        }
        this.isOverridden = true;

        window.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]): number => {
            return this.scheduleTask(callback.bind(null, ...args), { delay, priority: 'user-visible' });
        }) as any;

        window.clearTimeout = ((timeoutId?: number): void => {
            if (timeoutId === undefined) { return; }
            if (this.taskQueue.delete(timeoutId)) {
                this.pendingTaskCountSubject.next(this.taskQueue.size);
            } else {
                // Also attempt to clear a native timeout in case it was scheduled before override.
                this.originalClearTimeout.apply(window, [timeoutId]);
            }
        }) as any;
    }

    /**
     * Restores the original `window.setTimeout` and `window.clearTimeout` functions.
     * It gracefully reschedules any pending tasks using the native `setTimeout` to
     * ensure no callbacks are lost.
     */
    public restoreTimeouts(): void {
        if (!this.isOverridden) { return; }
        this.stopTicker();
        if (this.loggingEnabled) {
            console.warn('--- TimeoutScheduler: Restoring original functions and rescheduling pending tasks. ---');
        }
        window.setTimeout = this.originalSetTimeout as any;
        window.clearTimeout = this.originalClearTimeout;
        this.isOverridden = false;

        const now = performance.now();
        for (const task of this.taskQueue.values()) {
            const remainingDelay = Math.max(0, task.executeAt - now);
            this.originalSetTimeout(task.callback, remainingDelay, ...task.args);
        }
        this.taskQueue.clear();
        this.pendingTaskCountSubject.next(0);
    }

    /**
     * @internal Chooses and starts the most appropriate ticker based on the current
     * state of the task queue and page visibility.
     */
    private startTicker(): void {
        if (this.activeTicker !== 'none' || this.taskQueue.size === 0) { return; }

        if (this.runInBackground && typeof document !== 'undefined' && document.hidden) {
            this.activeTicker = 'interval';
            if (this.loggingEnabled) {
                console.log(`--- TimeoutScheduler: Page is hidden. Starting in background mode (setInterval @ ${BACKGROUND_TICK_INTERVAL_MS}ms). ---`);
            }
            this.backgroundTickerId = this.originalSetTimeout(this.animationFrameTick, BACKGROUND_TICK_INTERVAL_MS);
            return;
        }

        const hasUserVisibleTasks = Array.from(this.taskQueue.values()).some(t => t.priority === 'user-visible');

        if (hasUserVisibleTasks) {
            this.activeTicker = 'rAF';
            if (this.loggingEnabled) {
                console.log(`--- TimeoutScheduler: Starting in foreground mode (requestAnimationFrame). Budget: ${this.currentTasksPerFrame} tasks/frame.`);
            }
            this.animationFrameId = window.requestAnimationFrame(this.animationFrameTick);
        } else {
            this.activeTicker = 'rIC';
            if (this.loggingEnabled) {
                console.log('--- TimeoutScheduler: Only background tasks remain. Starting idle callback ticker. ---');
            }
            if (typeof window.requestIdleCallback === 'function') {
                this.idleCallbackId = window.requestIdleCallback(this.idleTick);
            } else {
                // Fallback to rAF if requestIdleCallback is not supported.
                this.animationFrameId = window.requestAnimationFrame(this.animationFrameTick);
            }
        }
    }

    /**
     * @internal Stops all active tickers.
     */
    private stopTicker(): void {
        if (this.animationFrameId) window.cancelAnimationFrame(this.animationFrameId);
        if (this.idleCallbackId && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(this.idleCallbackId);
        if (this.backgroundTickerId !== null) window.clearInterval(this.backgroundTickerId);

        this.animationFrameId = 0;
        this.idleCallbackId = 0;
        this.backgroundTickerId = null;
        if (this.activeTicker !== 'none') {
            this.activeTicker = 'none';
            if (this.loggingEnabled) console.log('--- TimeoutScheduler: Ticker stopped. ---');
        }
    }

    /**
     * @internal The tick function for `requestAnimationFrame`, which calls the main queue processor.
     */
    private animationFrameTick = (): void => this.processQueue();

    /**
     * @internal The tick function for `requestIdleCallback`, which calls the main queue processor.
     */
    private idleTick = (deadline: IdleDeadline): void => this.processQueue(deadline);

    /**
     * @internal The main processing loop that executes tasks from the queue based on
     * priority and the available time budget.
     * @param deadline Optional IdleDeadline object provided by `requestIdleCallback`.
     */
    private processQueue = (deadline?: IdleDeadline): void => {
        const isIdleTick = !!deadline;
        const frameStart = performance.now();
        const timeBudget = isIdleTick ? deadline.timeRemaining() : this.frameTimeBudgetMs;
        let tasksExecutedThisFrame = 0;

        const dueTasks = Array.from(this.taskQueue.values()).filter(task => task.executeAt <= frameStart);
        const highPriorityTasks = dueTasks.filter(t => t.priority === 'user-visible');
        const lowPriorityTasks = dueTasks.filter(t => t.priority === 'background');

        const process = (task: ScheduledTask) => {
            try { task.callback(...task.args); } catch (e) { console.error('Error executing scheduled callback:', e, task); }
            this.taskQueue.delete(task.id);
            tasksExecutedThisFrame++;
        };

        // Always process high-priority tasks first.
        for (const task of highPriorityTasks) {
            if (!isIdleTick && tasksExecutedThisFrame >= this.currentTasksPerFrame) break;
            process(task);
        }

        // Process low-priority tasks if there's time/budget left.
        for (const task of lowPriorityTasks) {
            const timeElapsed = performance.now() - frameStart;
            if (timeElapsed >= timeBudget || (!isIdleTick && tasksExecutedThisFrame >= this.currentTasksPerFrame)) break;
            process(task);
        }

        if (this.activeTicker === 'rAF') {
            this.adjustFrameBudget(performance.now() - frameStart);
        }

        this.pendingTaskCountSubject.next(this.taskQueue.size);
        this.scheduleNextTick();
    }

    /**
     * @internal Determines and schedules the next tick, potentially switching ticker
     * type if the nature of the remaining tasks has changed.
     */
    private scheduleNextTick(): void {
        if (this.taskQueue.size === 0) {
            this.stopTicker();
            return;
        }
        if (this.activeTicker === 'interval') return; // setInterval handles its own loop

        const hasUserVisibleTasks = Array.from(this.taskQueue.values()).some(t => t.priority === 'user-visible');

        if (hasUserVisibleTasks) {
            if (this.activeTicker !== 'rAF') {
                this.stopTicker();
                this.startTicker();
            } else {
                this.animationFrameId = window.requestAnimationFrame(this.animationFrameTick);
            }
        } else {
            if (this.activeTicker !== 'rIC') {
                if (this.loggingEnabled) console.log('--- TimeoutScheduler: Switching to idle callback mode for background tasks. ---');
                this.stopTicker();
                this.startTicker();
            } else if (typeof window.requestIdleCallback === 'function') {
                this.idleCallbackId = window.requestIdleCallback(this.idleTick);
            } else {
                this.animationFrameId = window.requestAnimationFrame(this.animationFrameTick);
            }
        }
    }

    /**
     * @internal Adjusts the tasks-per-frame budget for the next frame based on the
     * performance of the current frame.
     * @param frameDurationMs The time taken to execute tasks in the last frame.
     */
    private adjustFrameBudget(frameDurationMs: number): void {
        if (!this.dynamicBudgetEnabled) return;
        if (frameDurationMs > this.frameTimeBudgetMs && this.currentTasksPerFrame > 1) {
            const newBudget = Math.max(1, Math.floor(this.currentTasksPerFrame * 0.9));
            if (this.loggingEnabled) console.log(`--- Frame time exceeded budget (${frameDurationMs.toFixed(2)}ms). Reducing budget to ${newBudget}. ---`);
            this.currentTasksPerFrame = newBudget;
        } else if (frameDurationMs < this.frameTimeBudgetMs && this.currentTasksPerFrame < this.maxTasksPerFrame) {
            this.currentTasksPerFrame = Math.min(this.maxTasksPerFrame, this.currentTasksPerFrame + 1);
        }
    }

    /**
     * A final cleanup method. It ensures original timeout functions are restored,
     * removes any event listeners, and completes observables to prevent memory leaks.
     */
    public destroy(): void {
        if (this.runInBackground && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        }
        this.restoreTimeouts();
        this.pendingTaskCountSubject.complete();
    }

    /**
     * @internal Handles the 'visibilitychange' event to switch tickers for optimal
     * performance, pausing rAF when the tab is hidden.
     */
    private handleVisibilityChange = () => {
        this.stopTicker();
        if (this.taskQueue.size > 0) {
            this.startTicker();
        }
    };
}
