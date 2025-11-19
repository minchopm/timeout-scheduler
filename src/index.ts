import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Defines the execution strategy for the scheduler.
 * - `throughput` (Default): Prioritizes maximum task execution speed by using
 *   `requestAnimationFrame`. Ideal for UI animations and high-frequency updates.
 * - `responsiveness`: Prioritizes main-thread responsiveness by using
 *   `scheduler.postTask` (if available) to yield frequently.
 */
export type SchedulingStrategy = 'throughput' | 'responsiveness';

/**
 * Defines the priority of a task.
 * - `user-visible`: High priority, runs sooner in a frame's budget.
 * - `background`: Low priority, runs only if time is left in a frame's budget.
 */
export type TaskPriority = 'user-visible' | 'background';

/**
 * Options for scheduling a specific task.
 */
export interface TaskOptions {
    /** The delay in milliseconds before the task should be executed. */
    delay?: number;
    /** The priority of the task within the batching queue. */
    priority?: TaskPriority;
    /**
     * Determines if the task should be batched and throttled by the scheduler.
     * - `true` (Default): The task is added to the frame loop and executed according
     *   to the time budget. This is best for UI performance.
     * - `false`: The task bypasses the frame loop and uses a dedicated native timer.
     *   This is required for networking libraries (e.g., Socket.io) that need exact timing
     *   and cannot tolerate background throttling.
     */
    batching?: boolean;
}

/**
 * Global configuration for the TimeoutScheduler instance.
 */
export interface SchedulerConfig {
    /**
     * The primary scheduling strategy to use when the page is visible.
     * @default 'throughput'
     */
    primaryStrategy?: SchedulingStrategy;
    /**
     * If true, logs internal state changes to the console.
     * @default false
     */
    loggingEnabled?: boolean;
    /**
     * (rAF Mode) If true, automatically adjusts the number of tasks per frame based on execution time.
     * @default true
     */
    dynamicBudgetEnabled?: boolean;
    /**
     * (rAF Mode) The target execution time per frame in milliseconds.
     * @default 8
     */
    frameTimeBudgetMs?: number;
    /**
     * (rAF Mode) The initial number of tasks to execute per frame.
     * @default 50
     */
    initialTasksPerFrame?: number;
    /**
     * (rAF Mode) The maximum number of tasks allowed per frame.
     * @default 150
     */
    maxTasksPerFrame?: number;
    /**
     * The interval (in ms) for the background ticker when the tab is hidden.
     * Higher values reduce CPU usage; lower values improve background responsiveness.
     * @default 250
     */
    backgroundTickInterval?: number;
}

/**
 * Configuration for the `overrideTimeouts` method.
 */
export interface OverrideOptions {
    /**
     * A callback hook that allows you to determine the `TaskOptions` dynamically
     * whenever `setTimeout` is called.
     *
     * Use this to inspect the callback, delay, or arguments (or the Error stack)
     * to decide if a task should disable batching (e.g., for Socket.io).
     */
    getTaskOptions?: (callback: Function, delay: number, args: any[]) => TaskOptions;
}

/**
 * @internal Internal representation of a scheduled task.
 */
interface ScheduledTask {
    id: number;
    callback: (...args: any[]) => void;
    executeAt: number;
    args: any[];
    priority: TaskPriority;
    batching: boolean;
    /** If batching is false, this holds the ID of the native browser timer. */
    nativeTimerId?: number;
    /** Used for cancellation if the task is scheduled via scheduler.postTask. */
    postTaskController?: AbortController;
}

/**
 * A highly configurable, performance-oriented scheduler.
 * It intercepts or manages timer tasks to optimize main-thread usage,
 * providing frame-budgeting for UI work while allowing critical networking
 * tasks to bypass throttling.
 */
export class TimeoutScheduler {
    // --- Configuration ---
    private readonly primaryStrategy: SchedulingStrategy;
    private readonly loggingEnabled: boolean;
    private readonly dynamicBudgetEnabled: boolean;
    private readonly frameTimeBudgetMs: number;
    private readonly maxTasksPerFrame: number;
    private readonly initialTasksPerFrame: number;
    private readonly backgroundTickInterval: number;

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
    /** Emits the current number of pending tasks (both batched and non-batched). */
    public readonly pendingTaskCount$: Observable<number>;
    private readonly pendingTaskCountSubject = new BehaviorSubject<number>(0);

    /**
     * Constructs an instance of the TimeoutScheduler.
     * @param config Configuration options.
     */
    constructor(config?: SchedulerConfig) {
        this.pendingTaskCount$ = this.pendingTaskCountSubject.asObservable();

        this.primaryStrategy = config?.primaryStrategy ?? 'throughput';
        this.loggingEnabled = config?.loggingEnabled ?? false;
        this.dynamicBudgetEnabled = config?.dynamicBudgetEnabled ?? true;
        this.frameTimeBudgetMs = config?.frameTimeBudgetMs ?? 8;
        this.initialTasksPerFrame = config?.initialTasksPerFrame ?? 50;
        this.maxTasksPerFrame = config?.maxTasksPerFrame ?? 150;
        this.backgroundTickInterval = config?.backgroundTickInterval ?? 250;
        this.currentTasksPerFrame = this.initialTasksPerFrame;

        if (typeof window === 'undefined' || !window.performance) {
            throw new Error('TimeoutScheduler requires a browser environment with performance API support.');
        }

        // Check for native scheduler.postTask support
        this.isPostTaskSupported = typeof window !== 'undefined' &&
            'scheduler' in window &&
            typeof (window as any).scheduler.postTask === 'function';

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.handleVisibilityChange);
            // Initialize state based on current visibility
            this.handleVisibilityChange();
        }
    }

    /**
     * Schedules a task.
     * @param callback The function to execute.
     * @param options Configuration for delay, priority, and batching behavior.
     * @returns A unique Task ID (compatible with clearTimeout).
     */
    public scheduleTask(callback: (...args: any[]) => void, options?: TaskOptions): number {
        const taskId = ++this.taskIdCounter;
        const priority = options?.priority ?? 'user-visible';
        const useBatching = options?.batching ?? true;

        const delay = Number(options?.delay) || 0;
        const executeAt = performance.now() + delay;

        const task: ScheduledTask = {
            id: taskId,
            callback,
            executeAt,
            args: [],
            priority,
            batching: useBatching
        };

        this.taskQueue.set(taskId, task);
        this.pendingTaskCountSubject.next(this.taskQueue.size);

        // BRANCH 1: Non-Batched (Exact Timing)
        // If batching is disabled, we schedule a dedicated native timer immediately.
        // This bypasses the frame loop and background throttling.
        if (!useBatching) {
            // Casting to unknown then number ensures compatibility if Node types are present
            task.nativeTimerId = this.originalSetTimeout.call(window, () => {
                this.executeTaskImmediately(taskId);
            }, delay) as unknown as number;

            return taskId;
        }

        // BRANCH 2: Batched (Frame Budgeted)
        // If the scheduler is idle, kickstart the loop.
        if (this.currentSchedulingMode === 'idle' && this.taskQueue.size > 0) {
            this.startAppropriateTicker();
        } else if (this.currentSchedulingMode === 'postTask') {
            // In postTask mode, we schedule individually via the API
            this.runTaskWithPostTask(task);
        }

        return taskId;
    }

    /**
     * Cancels a scheduled task, whether it is batched or non-batched.
     * @param taskId The ID returned by scheduleTask.
     */
    public cancelTask(taskId: number): void {
        const task = this.taskQueue.get(taskId);
        if (task) {
            // Cleanup non-batched native timer
            if (task.nativeTimerId !== undefined) {
                this.originalClearTimeout.call(window, task.nativeTimerId);
            }
            // Cleanup postTask controller
            if (task.postTaskController) {
                task.postTaskController.abort();
            }

            this.taskQueue.delete(taskId);
            this.pendingTaskCountSubject.next(this.taskQueue.size);
        }
    }

    /**
     * Overrides the global `window.setTimeout` and `window.clearTimeout`.
     * Allows providing a hook to dynamically configure task options (e.g., disabling batching).
     * @param options Configuration for the override behavior.
     */
    public overrideTimeouts(options?: OverrideOptions): void {
        if (this.isOverridden) return;
        if (this.loggingEnabled) console.warn(`--- TimeoutScheduler (${this.primaryStrategy}): OVERRIDING global setTimeout. ---`);
        this.isOverridden = true;

        // Ensure the default return is cast to TaskOptions to avoid TS errors on property assignment
        const getOptions = options?.getTaskOptions || (() => ({ batching: true } as TaskOptions));

        // @ts-ignore
        window.setTimeout = (callback: (...args: any[]) => void, delay?: number, ...args: any[]): number => {
            const delayMs = Number(delay) || 0;

            // Dynamically determine options (e.g. check stack trace for Socket.io)
            const taskOptions = getOptions(callback, delayMs, args);

            // Ensure delay is carried over
            taskOptions.delay = delayMs;

            return this.scheduleTask(callback.bind(null, ...args), taskOptions);
        };

        // @ts-ignore
        window.clearTimeout = (timeoutId?: number): void => {
            if (timeoutId !== undefined) this.cancelTask(timeoutId);
        };
    }

    /**
     * Restores the original `window.setTimeout` and `window.clearTimeout`.
     * Any pending batched tasks are rescheduled to run natively.
     */
    public restoreTimeouts(): void {
        if (!this.isOverridden) return;
        this.stopAllTickers();

        // Cancel any active non-batched native timers to avoid duplicates
        this.taskQueue.forEach(task => {
            if (task.nativeTimerId) this.originalClearTimeout(task.nativeTimerId);
        });

        if (this.loggingEnabled) console.warn(`--- TimeoutScheduler: Restoring original functions. ---`);

        window.setTimeout = this.originalSetTimeout as any;
        window.clearTimeout = this.originalClearTimeout;
        this.isOverridden = false;

        // Reschedule all pending tasks using the native browser function
        const now = performance.now();
        for (const task of this.taskQueue.values()) {
            const remainingDelay = Math.max(0, task.executeAt - now);
            this.originalSetTimeout(task.callback, remainingDelay, ...task.args);
        }
        this.taskQueue.clear();
        this.pendingTaskCountSubject.next(0);
    }

    /**
     * Destroys the scheduler instance, removing listeners and restoring globals.
     */
    public destroy(): void {
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        }
        this.restoreTimeouts();
        this.pendingTaskCountSubject.complete();
    }

    // =========================================
    // Internal Logic
    // =========================================

    /**
     * Handles visibility changes to switch between rAF (high perf) and setTimeout (background).
     */
    private handleVisibilityChange = () => {
        this.stopAllTickers();
        this.startAppropriateTicker();
    };

    /**
     * Helper to execute a non-batched task immediately and remove it from the queue.
     */
    private executeTaskImmediately(taskId: number) {
        const task = this.taskQueue.get(taskId);
        if (!task) return;

        try {
            task.callback(...task.args);
        } catch (e) {
            console.error('Error executing non-batched callback:', e, task);
        } finally {
            this.taskQueue.delete(taskId);
            this.pendingTaskCountSubject.next(this.taskQueue.size);
        }
    }

    /**
     * Determines the correct scheduling loop based on tasks, strategy, and visibility.
     */
    private startAppropriateTicker() {
        // We only need a ticker loop for tasks that require batching.
        const hasBatchedTasks = Array.from(this.taskQueue.values()).some(t => t.batching);
        if (!hasBatchedTasks) {
            this.currentSchedulingMode = 'idle';
            return;
        }

        const isHidden = typeof document !== 'undefined' && document.hidden;
        const log = (mode: string) => {
            if (this.loggingEnabled) console.log(`--- TimeoutScheduler: Tab is ${isHidden ? 'hidden' : 'visible'}. Activating '${mode}' mode.`);
        };

        // 1. Responsiveness Strategy (User Preference)
        if (this.primaryStrategy === 'responsiveness' && this.isPostTaskSupported) {
            log('postTask');
            this.currentSchedulingMode = 'postTask';
            this.taskQueue.forEach(t => { if(t.batching) this.runTaskWithPostTask(t); });
            return;
        }

        // 2. Visible Tab (Throughput Strategy)
        if (!isHidden) {
            log('rAF');
            this.currentSchedulingMode = 'rAF';
            this.animationFrameId = window.requestAnimationFrame(this.processRafQueue);
        }
        // 3. Hidden Tab (Background)
        else {
            if (this.isPostTaskSupported) {
                // postTask is often throttled less aggressively than setTimeout in background
                log('postTask');
                this.currentSchedulingMode = 'postTask';
                this.taskQueue.forEach(t => { if(t.batching) this.runTaskWithPostTask(t); });
            } else {
                // Standard fallback to throttled setTimeout loop
                log('timeout');
                this.currentSchedulingMode = 'timeout';
                // Cast to number here as well to handle Node type environments
                this.backgroundTickerId = this.originalSetTimeout.call(window,
                    this.processRafQueue,
                    this.backgroundTickInterval // Uses the configurable interval
                ) as unknown as number;
            }
        }
    }

    /**
     * Stops all active loops (rAF, timeout) and aborts postTask controllers.
     */
    private stopAllTickers() {
        if (this.animationFrameId) window.cancelAnimationFrame(this.animationFrameId);
        if (this.backgroundTickerId) this.originalClearTimeout(this.backgroundTickerId);

        this.animationFrameId = 0;
        this.backgroundTickerId = null;

        // Abort any in-flight batched postTask executions
        this.taskQueue.forEach(task => {
            if (task.postTaskController && !task.postTaskController.signal.aborted) {
                task.postTaskController.abort();
            }
        });

        if (this.loggingEnabled && this.currentSchedulingMode !== 'idle') {
            console.log(`--- TimeoutScheduler: Stopping '${this.currentSchedulingMode}' ticker.`);
        }
        this.currentSchedulingMode = 'idle';
    }

    /**
     * Schedules a single batched task using scheduler.postTask.
     */
    private runTaskWithPostTask = (task: ScheduledTask) => {
        if (!task.batching) return; // Should not happen, but safety check
        if (task.postTaskController && !task.postTaskController.signal.aborted) return;

        const controller = new AbortController();
        task.postTaskController = controller;

        (window as any).scheduler.postTask(() => {
            // We reuse the immediate execution helper logic
            this.executeTaskImmediately(task.id);
        }, {
            signal: controller.signal,
            delay: Math.max(0, task.executeAt - performance.now()),
            priority: task.priority === 'user-visible' ? 'user-visible' : 'background'
        }).catch((err: any) => {
            // Ignore AbortErrors, log others
            if (err.name !== 'AbortError') {
                console.error('Error in scheduler.postTask:', err);
                this.taskQueue.delete(task.id);
                this.pendingTaskCountSubject.next(this.taskQueue.size);
            }
        });
    }

    /**
     * The main processing loop used by `rAF` and `timeout` modes.
     * Batches tasks and respects the frame budget.
     */
    private processRafQueue = (): void => {
        if (this.currentSchedulingMode !== 'rAF' && this.currentSchedulingMode !== 'timeout') {
            return;
        }

        const frameStart = performance.now();
        let tasksExecutedThisFrame = 0;

        // 1. Identify Tasks: Only process batched tasks that are due
        const dueTasks = Array.from(this.taskQueue.values())
            .filter(task => task.batching && task.executeAt <= frameStart);

        const highPriorityTasks = dueTasks.filter(t => t.priority === 'user-visible');
        const lowPriorityTasks = dueTasks.filter(t => t.priority === 'background');

        // Helper to execute and delete
        const process = (task: ScheduledTask) => {
            try { task.callback(...task.args); } catch (e) { console.error('Error executing scheduled callback:', e); }
            this.taskQueue.delete(task.id);
            tasksExecutedThisFrame++;
        };

        // 2. Execute High Priority (User Visible)
        for (const task of highPriorityTasks) {
            if (tasksExecutedThisFrame >= this.currentTasksPerFrame) break;
            process(task);
        }

        // 3. Execute Low Priority (Background) - Only if time permits
        for (const task of lowPriorityTasks) {
            const timeElapsed = performance.now() - frameStart;
            if (timeElapsed >= this.frameTimeBudgetMs || tasksExecutedThisFrame >= this.currentTasksPerFrame) break;
            process(task);
        }

        // 4. Adjust Budget
        this.adjustFrameBudget(performance.now() - frameStart);
        this.pendingTaskCountSubject.next(this.taskQueue.size);

        // 5. Schedule Next Tick
        const remainingBatchedTasks = Array.from(this.taskQueue.values()).some(t => t.batching);

        if (remainingBatchedTasks) {
            if (this.currentSchedulingMode === 'rAF') {
                this.animationFrameId = window.requestAnimationFrame(this.processRafQueue);
            } else if (this.currentSchedulingMode === 'timeout') {
                // Cast to number for Node type compatibility
                this.backgroundTickerId = this.originalSetTimeout.call(window,
                    this.processRafQueue,
                    this.backgroundTickInterval
                ) as unknown as number;
            }
        } else {
            this.currentSchedulingMode = 'idle';
        }
    }

    /**
     * Adjusts the number of tasks allowed per frame based on how long the previous frame took.
     */
    private adjustFrameBudget(frameDurationMs: number): void {
        if (!this.dynamicBudgetEnabled || this.currentSchedulingMode !== 'rAF') return;

        // If we exceeded budget, reduce task count
        if (frameDurationMs > this.frameTimeBudgetMs && this.currentTasksPerFrame > 1) {
            const newBudget = Math.max(1, Math.floor(this.currentTasksPerFrame * 0.9));
            if (this.loggingEnabled) console.log(`--- Frame budget exceeded (${frameDurationMs.toFixed(2)}ms). Reducing to ${newBudget} tasks/frame.`);
            this.currentTasksPerFrame = newBudget;
        }
        // If we have plenty of time, increase task count
        else if (frameDurationMs < this.frameTimeBudgetMs && this.currentTasksPerFrame < this.maxTasksPerFrame) {
            this.currentTasksPerFrame = Math.min(this.maxTasksPerFrame, this.currentTasksPerFrame + 1);
        }
    }
}
