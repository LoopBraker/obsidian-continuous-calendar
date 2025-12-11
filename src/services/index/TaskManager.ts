import { TaskNote } from './IndexTypes';
import { getEndDateFromDuration } from '../../util/datesFromDuration';
import {
    eachDayOfInterval,
    parseISO,
    format,
    isValid,
    max as maxDate,
} from 'date-fns';

export class TaskManager {
    // Map of date (YYYY-MM-DD) -> TaskNote[]
    public tasksByDate: Map<string, TaskNote[]> = new Map();

    // NEW: keep one canonical copy of each task so we can "carry it forward"
    private allTasksByPath: Map<string, TaskNote> = new Map();

    public clear() {
        this.tasksByDate.clear();
        this.allTasksByPath.clear();
    }

    public addTask(task: TaskNote) {
        // Always remember the task (so it can appear on any later date)
        if (task?.path) {
            this.allTasksByPath.set(task.path, task);
        }

        // --- existing behavior: scheduled range (and duration) ---
        if (task.scheduled) {
            let start = task.scheduled;
            let end = task.scheduled;

            if (task.timeEstimate) {
                const duration = parseInt(String(task.timeEstimate), 10);
                if (!isNaN(duration) && duration > 0) {
                    // Subtract 1 minute for inclusive end date logic (like RangeManager)
                    end = getEndDateFromDuration(start, duration - 1);
                }
            }

            try {
                const startDate = parseISO(start);
                const endDate = parseISO(end);

                if (isValid(startDate) && isValid(endDate)) {
                    const days = eachDayOfInterval({ start: startDate, end: endDate });
                    for (const day of days) {
                        const dateKey = format(day, 'yyyy-MM-dd');
                        this.addToDate(dateKey, task);
                    }
                } else {
                    this.addToDate(task.scheduled, task);
                }
            } catch (e) {
                console.warn('TaskManager: error calculating interval', e);
                this.addToDate(task.scheduled, task);
            }
        }

        // --- existing behavior: also index due date ---
        if (task.due) {
            this.addToDate(task.due, task);
        }

        // --- Index completed dates (New Requirement) ---
        if (task.completedDate) {
            this.addToDate(task.completedDate, task);
        }
        if (task.complete_instances && Array.isArray(task.complete_instances)) {
            task.complete_instances.forEach(date => {
                if (date) this.addToDate(date, task);
            });
        }
    }

    public getTasksForDate(dateStr: string): TaskNote[] {
        // 1) tasks explicitly indexed for this date (scheduled range + due)
        const base = this.tasksByDate.get(dateStr) || [];

        // 2) carry-forward behavior (your new requirement):
        // any task whose scheduled date is <= requested date should also appear
        // (duration/due do NOT limit this; presentation-layer can stop it later)
        const out: TaskNote[] = [...base];
        const seen = new Set(out.map(t => t.path));

        for (const task of this.allTasksByPath.values()) {
            if (!task.scheduled) continue;

            // YYYY-MM-DD strings compare correctly lexicographically
            if (task.scheduled <= dateStr && !seen.has(task.path)) {
                out.push(task);
                seen.add(task.path);
            }
        }

        return out;
    }

    private addToDate(dateStr: string, task: TaskNote) {
        if (!this.tasksByDate.has(dateStr)) {
            this.tasksByDate.set(dateStr, []);
        }
        const list = this.tasksByDate.get(dateStr)!;
        if (!list.some(t => t.path === task.path)) {
            list.push(task);
        }
    }

    public removeTasksForFile(path: string) {
        // remove from the carry-forward registry too
        this.allTasksByPath.delete(path);

        for (const [date, tasks] of this.tasksByDate.entries()) {
            const filtered = tasks.filter(t => t.path !== path);
            if (filtered.length === 0) {
                this.tasksByDate.delete(date);
            } else {
                this.tasksByDate.set(date, filtered);
            }
        }
    }
}