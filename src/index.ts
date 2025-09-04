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
     * If true, the scheduler will log its status to the console. This includes
     * overriding/restoring timeouts and switching between ticker mechanisms.
     * @default false
     */
    loggingEnabled?: boolean;

    /**
     * If true, the scheduler will switch to a 'setInterval' based ticker
     * when the tab is in the background. This ensures tasks continue to run,
     * even when the page is not visible.
     * @default false
     */
    runInBackground?: boolean;
}

/**
 * @internal
 * The interval (in ms) for the less frequent background ticker.
 */
const BACKGROUND_TICK_INTERVAL_MS = 250; // Ticks 4 times per second.

/**
 * @internal
 * An internal interface representing a task scheduled to be executed.
 */
interface ScheduledTask {
    id: number;
    callback: (...args: any[]) => void;
    executeAt: number;
    args: any[];
}

/**
 * A performance-oriented scheduler that overrides `setTimeout` to prevent UI
 * blocking. It uses `requestAnimationFrame` for smooth performance when the tab
 * is visible, and can intelligently switch to `setInterval` to ensure task
 * execution when the tab is in the background.
 */
export class TimeoutScheduler {
    // --- Private Properties ---

    private readonly tasksPerFrameBudget: number;
    private readonly loggingEnabled: boolean;
    private readonly runInBackground: boolean;

    private readonly originalSetTimeout: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => number = window.setTimeout;
    private readonly originalClearTimeout = window.clearTimeout;

    private isOverridden = false;
    private isTicking = false;
    private taskIdCounter = 0;
    private animationFrameId = 0;
    private backgroundTickerId: number | null = null;

    private taskQueue = new Map<number, ScheduledTask>();

    // --- Public Properties ---

    private readonly pendingTaskCountSubject = new BehaviorSubject<number>(0);
    public readonly pendingTaskCount$: Observable<number> = this.pendingTaskCountSubject.asObservable();

    /**
     * Constructs an instance of the TimeoutScheduler.
     * @param config Optional configuration to customize the scheduler's behavior.
     */
    constructor(config?: SchedulerConfig) {
        this.tasksPerFrameBudget = config?.tasksPerFrameBudget ?? 75;
        this.loggingEnabled = config?.loggingEnabled ?? false;
        this.runInBackground = config?.runInBackground ?? false;

        if (typeof window === 'undefined' || typeof window.requestAnimationFrame === 'undefined') {
            throw new Error('TimeoutScheduler can only run in a browser environment with requestAnimationFrame support.');
        }

        // If configured to run in the background, listen for page visibility changes.
        if (this.runInBackground && typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.handleVisibilityChange);
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
     * It gracefully reschedules any pending tasks using the native `setTimeout`.
     */
    public restoreTimeouts(): void {
        if (!this.isOverridden) { return; }
        if (this.loggingEnabled) {
            console.warn('--- TimeoutScheduler: Restoring original functions and rescheduling pending tasks. ---');
        }
        this.stopTicker();

        window.setTimeout = this.originalSetTimeout as any;
        window.clearTimeout = this.originalClearTimeout;
        this.isOverridden = false;

        const now = Date.now();
        for (const task of this.taskQueue.values()) {
            const remainingDelay = Math.max(0, task.executeAt - now);
            this.originalSetTimeout.apply(window, [task.callback, remainingDelay, ...task.args]);
        }

        this.taskQueue.clear();
        this.pendingTaskCountSubject.next(0);
    }

    /**
     * Starts the appropriate ticker based on page visibility and configuration.
     */
    private startTicker(): void {
        if (this.isTicking) { return; }
        this.isTicking = true;

        if (this.runInBackground && typeof document !== 'undefined' && document.hidden) {
            if (this.loggingEnabled) {
                console.log(`--- TimeoutScheduler: Starting in background mode (setInterval @ ${BACKGROUND_TICK_INTERVAL_MS}ms). ---`);
            }
            this.backgroundTickerId = window.setInterval(this.tick, BACKGROUND_TICK_INTERVAL_MS);
        } else {
            if (this.loggingEnabled) {
                console.log('--- TimeoutScheduler: Starting in foreground mode (requestAnimationFrame). ---');
            }
            this.animationFrameId = window.requestAnimationFrame(this.tick);
        }
    }

    /**
     * Stops all running tickers.
     */
    private stopTicker(): void {
        if (!this.isTicking) { return; }

        window.cancelAnimationFrame(this.animationFrameId);

        if (this.backgroundTickerId !== null) {
            window.clearInterval(this.backgroundTickerId);
            this.backgroundTickerId = null;
        }

        if (this.loggingEnabled) {
            console.log('--- TimeoutScheduler: Ticker stopped. ---');
        }
        this.isTicking = false;
    }

    /**
     * The main processing loop, executed by either ticker. It processes due tasks
     * from the queue while respecting the frame budget.
     */
    private tick = (): void => {
        // In rAF mode, the loop stops itself. In setInterval mode, we must guard.
        if (!this.isTicking) { return; }

        const now = Date.now();
        let tasksExecutedThisFrame = 0;

        for (const task of this.taskQueue.values()) {
            if (tasksExecutedThisFrame >= this.tasksPerFrameBudget) { break; }
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

        // If using rAF, we must request the next frame. setInterval handles this automatically.
        if (this.taskQueue.size > 0 && this.backgroundTickerId === null) {
            this.animationFrameId = window.requestAnimationFrame(this.tick);
        } else if (this.taskQueue.size === 0) {
            this.stopTicker();
        }
    }

    /**
     * A final cleanup method. It ensures original timeout functions are restored
     * and removes any event listeners to prevent memory leaks.
     */
    public destroy(): void {
        if (this.runInBackground && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        }
        this.restoreTimeouts();
        this.pendingTaskCountSubject.complete();
    }

    /**
     * Handles the 'visibilitychange' event to switch tickers for optimal performance.
     */
    private handleVisibilityChange = () => {
        if (!this.isTicking) { return; }

        if (document.hidden) {
            // PAGE IS NOW HIDDEN: Switch from smooth rAF to reliable setInterval.
            if (this.loggingEnabled) {
                console.warn('--- TimeoutScheduler: Tab hidden. Switching to setInterval ticker. ---');
            }
            window.cancelAnimationFrame(this.animationFrameId);
            this.backgroundTickerId = window.setInterval(this.tick, BACKGROUND_TICK_INTERVAL_MS);
        } else {
            // PAGE IS NOW VISIBLE: Switch back from setInterval to smooth rAF.
            if (this.loggingEnabled) {
                console.warn('--- TimeoutScheduler: Tab visible. Switching back to requestAnimationFrame ticker. ---');
            }
            if (this.backgroundTickerId !== null) {
                window.clearInterval(this.backgroundTickerId);
                this.backgroundTickerId = null;
            }
            this.animationFrameId = window.requestAnimationFrame(this.tick);
        }
    };
}
