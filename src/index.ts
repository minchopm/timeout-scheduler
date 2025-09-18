import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Defines the execution strategy for the scheduler, allowing users to prioritize
 * either raw processing speed or UI smoothness.
 * - `throughput` (Default): Prioritizes maximum task execution speed by using
 *   `requestAnimationFrame` when the page is visible. This is ideal for running
 *   a high volume of small, fast tasks.
 * - `responsiveness`: Prioritizes keeping the UI smooth and interactive by using
 *   `scheduler.postTask` whenever available. This is safer for tasks that might
 *   be long-running, as it prevents blocking the main thread.
 */
export type SchedulingStrategy = 'throughput' | 'responsiveness';

/**
 * Defines the priority of a task.
 * - `user-visible`: High priority, runs sooner in a frame's budget.
 * - `background`: Low priority, runs only if time is left in a frame's budget.
 */
export type TaskPriority = 'user-visible' | 'background';

/**
 * Defines the options for scheduling a task with priority.
 */
export interface TaskOptions {
    /** The delay in milliseconds before the task should be executed. */
    delay?: number;
    /** The priority of the task, affecting its execution order. */
    priority?: TaskPriority;
}

/**
 * Defines the configuration options for the scheduler.
 */
export interface SchedulerConfig {
    /**
     * The primary scheduling strategy to use. Defaults to 'throughput'.
     * @default 'throughput'
     */
    primaryStrategy?: SchedulingStrategy;
    /**
     * (rAF Mode) The initial number of tasks to execute per frame.
     * @default 50
     */
    initialTasksPerFrame?: number;
    /**
     * If true, logs strategy changes and performance adjustments to the console.
     * @default false
     */
    loggingEnabled?: boolean;
    /**
     * (rAF Mode) If true, enables dynamic adjustment of the tasks-per-frame budget.
     * @default true
     */
    dynamicBudgetEnabled?: boolean;
    /**
     * (rAF Mode) The target frame processing time in milliseconds.
     * @default 8
     */
    frameTimeBudgetMs?: number;
    /**
     * @deprecated This property is no longer used and has no effect. Background
     * execution is now handled automatically and is always enabled.
     */
    runInBackground?: boolean;
    /**
     * (rAF Mode) The maximum number of tasks to execute in a single frame.
     * @default 150
     */
    maxTasksPerFrame?: number;
}

/**
 * @internal An internal interface representing a task in the queue.
 */
interface ScheduledTask {
    id: number;
    callback: (...args: any[]) => void;
    executeAt: number;
    args: any[];
    priority: TaskPriority;
    postTaskController?: AbortController; // Used for cancellation in postTask mode
}

/**
 * @internal The interval (in ms) for the least-performant background ticker.
 */
const BACKGROUND_TICK_INTERVAL_MS = 250;

/**
 * A highly configurable, performance-oriented scheduler. It allows developers to
 * choose between a 'throughput'-first strategy (using requestAnimationFrame for
 * maximum speed) or a 'responsiveness'-first strategy (using scheduler.postTask
 * to ensure a non-blocking UI). It intelligently handles background execution
 * and provides robust fallbacks for older browsers.
 */
export class TimeoutScheduler {
    // --- Configuration ---
    private readonly primaryStrategy: SchedulingStrategy;
    private readonly loggingEnabled: boolean;
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
    private taskQueue = new Map<number, ScheduledTask>();
    private readonly isPostTaskSupported: boolean;
    private currentSchedulingMode: 'rAF' | 'postTask' | 'timeout' | 'idle' = 'idle';

    // --- rAF State ---
    private currentTasksPerFrame: number;
    private animationFrameId = 0;

    // --- setTimeout Fallback State ---
    private backgroundTickerId: number | null = null;

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

        this.primaryStrategy = config?.primaryStrategy ?? 'throughput';
        this.loggingEnabled = config?.loggingEnabled ?? false;
        this.dynamicBudgetEnabled = config?.dynamicBudgetEnabled ?? true;
        this.frameTimeBudgetMs = config?.frameTimeBudgetMs ?? 8;
        this.initialTasksPerFrame = config?.initialTasksPerFrame ?? 50;
        this.maxTasksPerFrame = config?.maxTasksPerFrame ?? 150;
        this.currentTasksPerFrame = this.initialTasksPerFrame;

        if (typeof window === 'undefined' || !window.performance) {
            throw new Error('TimeoutScheduler requires a browser environment with performance API support.');
        }

        this.isPostTaskSupported = typeof window !== 'undefined' && 'scheduler' in window && typeof (window as any).scheduler.postTask === 'function';

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.handleVisibilityChange);
            this.handleVisibilityChange();
        }
    }

    /**
     * Schedules a task with a specific priority.
     * @param callback The function to execute.
     * @param options The scheduling options, including delay and priority.
     * @returns The ID of the scheduled task, which can be used for cancellation.
     */
    public scheduleTask(callback: (...args: any[]) => void, options?: TaskOptions): number {
        const taskId = ++this.taskIdCounter;
        const priority = options?.priority ?? 'user-visible';

        const delay = Number(options?.delay) || 0;
        const executeAt = performance.now() + delay;

        const task: ScheduledTask = { id: taskId, callback, executeAt, args: [], priority };
        this.taskQueue.set(taskId, task);
        this.pendingTaskCountSubject.next(this.taskQueue.size);

        if (this.currentSchedulingMode === 'idle' && this.taskQueue.size > 0) {
            this.startAppropriateTicker();
        } else if (this.currentSchedulingMode === 'postTask') {
            this.runTaskWithPostTask(task);
        }

        return taskId;
    }

    /**
     * Cancels a previously scheduled task.
     * @param taskId The ID of the task to cancel.
     */
    public cancelTask(taskId: number): void {
        const task = this.taskQueue.get(taskId);
        if (task) {
            if (task.postTaskController) {
                task.postTaskController.abort();
            }
            this.taskQueue.delete(taskId);
            this.pendingTaskCountSubject.next(this.taskQueue.size);
        }
    }

    /**
     * Overrides the global `window.setTimeout` and `window.clearTimeout` functions.
     * All tasks scheduled via `setTimeout` will be managed by this scheduler.
     */
    public overrideTimeouts(): void {
        if (this.isOverridden) return;
        if (this.loggingEnabled) console.warn(`--- TimeoutScheduler (${this.primaryStrategy}): OVERRIDING global setTimeout. ---`);
        this.isOverridden = true;

        window.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]): number => {
            return this.scheduleTask(callback.bind(null, ...args), { delay });
        }) as any;

        window.clearTimeout = ((timeoutId?: number): void => {
            if (timeoutId !== undefined) this.cancelTask(timeoutId);
        }) as any;
    }

    /**
     * Restores the original `window.setTimeout` and `window.clearTimeout` functions.
     * Any pending tasks are gracefully rescheduled using the native `setTimeout`.
     */
    public restoreTimeouts(): void {
        if (!this.isOverridden) return;
        this.stopAllTickers();
        if (this.loggingEnabled) console.warn(`--- TimeoutScheduler (${this.primaryStrategy}): Restoring original functions and rescheduling tasks. ---`);

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
     * A final cleanup method. Restores timeouts, removes event listeners, and
     * completes observables to prevent memory leaks.
     */
    public destroy(): void {
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        }
        this.restoreTimeouts();
        this.pendingTaskCountSubject.complete();
    }

    /**
     * @internal Handles the 'visibilitychange' event to switch scheduling strategies.
     */
    private handleVisibilityChange = () => {
        this.stopAllTickers();
        this.startAppropriateTicker();
    };

    /**
     * @internal Determines and starts the best scheduling ticker based on the
     * current strategy, page visibility, and browser support.
     */
    private startAppropriateTicker() {
        if (this.taskQueue.size === 0) {
            this.currentSchedulingMode = 'idle';
            return;
        }

        const isHidden = typeof document !== 'undefined' && document.hidden;
        const log = (mode: string) => {
            if (this.loggingEnabled) console.log(`--- TimeoutScheduler (${this.primaryStrategy}): Tab is ${isHidden ? 'hidden' : 'visible'}. Activating '${mode}' mode.`);
        };

        if (this.primaryStrategy === 'responsiveness' && this.isPostTaskSupported) {
            log('postTask');
            this.currentSchedulingMode = 'postTask';
            this.taskQueue.forEach(this.runTaskWithPostTask);
            return;
        }

        if (!isHidden) {
            log('rAF');
            this.currentSchedulingMode = 'rAF';
            this.animationFrameId = window.requestAnimationFrame(this.processRafQueue);
        } else {
            if (this.isPostTaskSupported) {
                log('postTask');
                this.currentSchedulingMode = 'postTask';
                this.taskQueue.forEach(this.runTaskWithPostTask);
            } else {
                log('timeout');
                this.currentSchedulingMode = 'timeout';
                this.backgroundTickerId = this.originalSetTimeout(this.processRafQueue, BACKGROUND_TICK_INTERVAL_MS);
            }
        }
    }

    /**
     * @internal Stops all active tickers and aborts any in-flight postTask controllers.
     * This is a "heavy" operation for major state changes like hiding the tab.
     */
    private stopAllTickers() {
        if (this.animationFrameId) window.cancelAnimationFrame(this.animationFrameId);
        if (this.backgroundTickerId) this.originalClearTimeout(this.backgroundTickerId);

        this.animationFrameId = 0;
        this.backgroundTickerId = null;

        this.taskQueue.forEach(task => {
            if (task.postTaskController && !task.postTaskController.signal.aborted) {
                task.postTaskController.abort();
            }
        });

        if (this.loggingEnabled && this.currentSchedulingMode !== 'idle') {
            console.log(`--- TimeoutScheduler (${this.primaryStrategy}): Stopping '${this.currentSchedulingMode}' ticker.`);
        }
        this.currentSchedulingMode = 'idle';
    }

    /**
     * @internal Schedules and executes a single task using the `scheduler.postTask` API.
     */
    private runTaskWithPostTask = (task: ScheduledTask) => {
        if (task.postTaskController && !task.postTaskController.signal.aborted) return;

        const controller = new AbortController();
        task.postTaskController = controller;
        const delay = Math.max(0, task.executeAt - performance.now());

        (window as any).scheduler.postTask(() => {
            try {
                task.callback(...task.args);
            } catch (e) {
                console.error('Error executing postTask callback:', e, task);
            } finally {
                this.taskQueue.delete(task.id);
                this.pendingTaskCountSubject.next(this.taskQueue.size);
            }
        }).catch((err: any) => {
            if (err.name !== 'AbortError') {
                console.error('An unexpected error occurred in scheduler.postTask:', err);
                if (this.taskQueue.has(task.id)) {
                    this.taskQueue.delete(task.id);
                    this.pendingTaskCountSubject.next(this.taskQueue.size);
                }
            }
        });
    }

    /**
     * @internal The main processing loop for `requestAnimationFrame` and `setTimeout` modes.
     */
    private processRafQueue = (): void => {
        if (this.currentSchedulingMode !== 'rAF' && this.currentSchedulingMode !== 'timeout') {
            return;
        }

        const frameStart = performance.now();
        let tasksExecutedThisFrame = 0;

        const dueTasks = Array.from(this.taskQueue.values()).filter(task => task.executeAt <= frameStart);
        const highPriorityTasks = dueTasks.filter(t => t.priority === 'user-visible');
        const lowPriorityTasks = dueTasks.filter(t => t.priority === 'background');

        const process = (task: ScheduledTask) => {
            try { task.callback(...task.args); } catch (e) { console.error('Error executing scheduled callback:', e, task); }
            this.taskQueue.delete(task.id);
            tasksExecutedThisFrame++;
        };

        for (const task of highPriorityTasks) {
            if (tasksExecutedThisFrame >= this.currentTasksPerFrame) break;
            process(task);
        }

        for (const task of lowPriorityTasks) {
            const timeElapsed = performance.now() - frameStart;
            if (timeElapsed >= this.frameTimeBudgetMs || tasksExecutedThisFrame >= this.currentTasksPerFrame) break;
            process(task);
        }

        this.adjustFrameBudget(performance.now() - frameStart);
        this.pendingTaskCountSubject.next(this.taskQueue.size);

        if (this.currentSchedulingMode === 'rAF') {
            this.animationFrameId = window.requestAnimationFrame(this.processRafQueue);
        } else if (this.currentSchedulingMode === 'timeout') {
            if (this.taskQueue.size > 0) {
                this.backgroundTickerId = this.originalSetTimeout(this.processRafQueue, BACKGROUND_TICK_INTERVAL_MS);
            } else {
                this.currentSchedulingMode = 'idle';
            }
        }
    }

    /**
     * @internal (rAF Mode) Adjusts the tasks-per-frame budget for the next frame.
     */
    private adjustFrameBudget(frameDurationMs: number): void {
        if (!this.dynamicBudgetEnabled || this.currentSchedulingMode !== 'rAF') return;

        if (frameDurationMs > this.frameTimeBudgetMs && this.currentTasksPerFrame > 1) {
            const newBudget = Math.max(1, Math.floor(this.currentTasksPerFrame * 0.9));
            if (this.loggingEnabled) console.log(`--- Frame budget exceeded (${frameDurationMs.toFixed(2)}ms). Reducing to ${newBudget} tasks/frame.`);
            this.currentTasksPerFrame = newBudget;
        } else if (frameDurationMs < this.frameTimeBudgetMs && this.currentTasksPerFrame < this.maxTasksPerFrame) {
            this.currentTasksPerFrame = Math.min(this.maxTasksPerFrame, this.currentTasksPerFrame + 1);
        }
    }
}
