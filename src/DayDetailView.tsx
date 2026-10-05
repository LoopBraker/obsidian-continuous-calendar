import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import { App, Platform, setIcon, TFile } from 'obsidian';
import { format, parseISO, differenceInDays, addDays } from 'date-fns';
import { RRule } from 'rrule';
import { IndexService, type CalendarDisplayEvent, type RangeNote, type TaskNote } from './services/IndexService';
import type { SyncStatus } from './services/sync/model';
import { addCivilDays, eventCivilDayBounds } from './services/sync/notes/CalendarNoteTarget';
import { formatCalendarEventTime, syncStatusLabel } from './components/SyncUi';
import { openSyncEventModal } from './modals/SyncEventModal';
import { openSyncNoteScopeModal } from './modals/SyncNoteScopeModal';
import { openSyncLinkedNoteModal } from './modals/SyncLinkedNoteModal';
import { type Holiday } from './services/holiday/HolidayTypes';

export type CalendarEventNoteActionScope = 'series' | 'occurrence' | 'occurrence-day';

interface DayDetailViewProps {
    dateKey: string;
    viewMode: 'Continuous' | 'month';
    index: IndexService;
    app: App;
    settings: any;
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
    onOpenNote: (date: string) => void;
    onCreateSyncEvent?: (dateKey: string) => void;
    canCreateSyncEvent?: boolean;
    onEditSyncEvent?: (eventKey: string) => void;
    onDeleteSyncEvent?: (eventKey: string) => Promise<boolean>;
    onCreateEventNote?: (eventKey: string, scope?: CalendarEventNoteActionScope, selectedDate?: string) => void;
}

/** Return only note actions that have a verified target for this selected civil date. */
export function getCalendarEventNoteActionScopes(
    event: CalendarDisplayEvent,
    selectedDate: string,
): CalendarEventNoteActionScope[] {
    if (event.status === 'remote_deleted') return [];
    if (event.scope === 'series') {
        return event.providerWriteKey || event.masterRemoteId ? ['series'] : [];
    }
    if (event.scope !== 'occurrence') return [];

    // A verified master remains a safe note target even when its occurrence
    // row is stale, cancelled, or locally approximated.
    const scopes: CalendarEventNoteActionScope[] = event.providerWriteKey && event.masterRemoteId ? ['series'] : [];
    if (event.cancelled || event.unresolved || event.providerResolved !== true || event.stale || !event.providerWriteKey) return scopes;
    const bounds = eventCivilDayBounds(event.event);
    if (!bounds || selectedDate < bounds.startDate || selectedDate >= bounds.endDateExclusive) return scopes;

    scopes.push('occurrence');
    const secondDate = addCivilDays(bounds.startDate, 1);
    if (secondDate && secondDate < bounds.endDateExclusive) scopes.push('occurrence-day');
    return scopes;
}

export interface CalendarEventNoteRowActions {
    readonly notePaths: readonly string[];
    readonly titleAction: 'none' | 'open' | 'choose';
    readonly showCreateNote: boolean;
    readonly createNoteScopes: readonly CalendarEventNoteActionScope[];
}

/** Resolve the note links and actions for a row already projected to the selected date. */
export function getCalendarEventNoteRowActions(
    event: CalendarDisplayEvent,
    selectedDate: string,
    canCreateNote: boolean,
): CalendarEventNoteRowActions {
    // notePath is retained as a fallback for legacy sources. When notePaths is
    // present, it is the date-projected set and must be treated as authoritative.
    const paths = event.notePaths !== undefined
        ? event.notePaths
        : event.notePath ? [event.notePath] : [];
    const notePaths = [...new Set(paths.filter(path => path.length > 0))];
    const createNoteScopes = canCreateNote
        ? getCalendarEventNoteActionScopes(event, selectedDate)
        : [];

    return {
        notePaths,
        titleAction: notePaths.length === 1 ? 'open' : notePaths.length > 1 ? 'choose' : 'none',
        showCreateNote: notePaths.length === 0 && createNoteScopes.length > 0,
        createNoteScopes,
    };
}

/** Exact provider key for a write; locally expanded rows have no safe edit target. */
export function getCalendarEventEditKey(event: CalendarDisplayEvent): string | undefined {
    if (event.providerResolved !== true || event.stale || event.cancelled || event.unresolved || event.status === 'remote_deleted') return undefined;
    return event.providerWriteKey;
}

// Utility to convert tint colors to text colors for better readability
const convertTintToTextColor = (color: string | undefined): string | undefined => {
    if (!color) return color;
    // Convert var(--color-red-tint) to var(--color-red-text)
    if (color.includes('-tint')) {
        return color.replace('-tint', '-text');
    }
    return color;
};

const ObsidianIcon = ({ icon }: { icon: string }) => {
    return (
        <span
            ref={el => {
                if (el) {
                    el.empty();
                    setIcon(el, icon);
                }
            }}
            className="react-obsidian-icon"
            aria-hidden="true"
        />
    );
};

const SYNC_STATUS_ICONS: Readonly<Record<SyncStatus, string>> = {
    pending: 'clock',
    synced: 'check',
    conflict: 'alert-triangle',
    remote_deleted: 'calendar-off',
    unsupported: 'info',
    error: 'circle-x',
};

const SyncStatusIcon = ({ status }: { status?: SyncStatus }) => {
    if (!status) return null;
    const label = syncStatusLabel(status);
    if (!label) return null;

    return (
        <span
            className={`sync-event-status-icon sync-status-${status}`}
            title={label}
            role="img"
            aria-label={`Sync status: ${label}`}
        >
            <ObsidianIcon icon={SYNC_STATUS_ICONS[status]} />
        </span>
    );
};

const SyncProjectionStatusIcons = ({ event }: { event: CalendarDisplayEvent }) => {
    const states = [
        ...(event.masterRemoteId && event.status !== 'remote_deleted' ? [{ label: 'Recurring series', icon: 'repeat', className: 'sync-status-recurring' }] : []),
        ...(event.stale ? [{ label: 'Occurrence projection is stale', icon: 'clock', className: 'sync-status-pending' }] : []),
        ...(event.cancelled ? [{ label: 'Occurrence is cancelled', icon: 'calendar-off', className: 'sync-status-remote_deleted' }] : []),
        ...(event.unresolved ? [{ label: 'Occurrence ownership is unresolved', icon: 'alert-triangle', className: 'sync-status-unsupported' }] : []),
        ...(event.localRepairPending ? [{ label: 'Google change saved; local note repair pending', icon: 'wrench', className: 'sync-status-error' }] : []),
    ];

    return <>
        {states.map(state => (
            <span
                key={state.label}
                className={`sync-event-status-icon ${state.className}`}
                title={state.label}
                role="img"
                aria-label={state.label}
            >
                <ObsidianIcon icon={state.icon} />
            </span>
        ))}
    </>;
};

export const DayDetailView = ({ dateKey, viewMode, index, app, settings, onClose, onPrev, onNext, onOpenNote, onCreateSyncEvent, canCreateSyncEvent, onEditSyncEvent, onDeleteSyncEvent, onCreateEventNote }: DayDetailViewProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const [notes, setNotes] = useState<Array<{ path: string; name: string; color?: string; tags: string[]; symbol?: string; isRecurring?: boolean; status?: SyncStatus }>>([]);
    const [syncEvents, setSyncEvents] = useState<readonly CalendarDisplayEvent[]>([]);
    const [ranges, setRanges] = useState<RangeNote[]>([]);
    const [tasks, setTasks] = useState<TaskNote[]>([]);
    const [holidays, setHolidays] = useState<Holiday[]>([]);
    const [hasDailyNote, setHasDailyNote] = useState(false);
    const syncSettings = index.settings?.sync;
    const canWriteSyncEvents = Platform.isDesktopApp
        && syncSettings?.syncMode === 'bidirectional'
        && Boolean(syncSettings.providerId && syncSettings.accountId && syncSettings.calendarId);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (viewMode !== 'Continuous') return;

            if (e.key === 'Escape' || e.key === 'Esc') {
                const doc = containerRef.current?.ownerDocument || document;
                const isObsidianPopupOpen = !!doc.querySelector('.modal-container, .prompt, .suggestion-container, .menu');
                if (isObsidianPopupOpen) {
                    return;
                }

                const leaf = containerRef.current?.closest('.workspace-leaf');
                if (leaf && !leaf.classList.contains('mod-active')) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                onCloseRef.current();
            }
        };

        const doc = containerRef.current?.ownerDocument || document;
        doc.addEventListener('keydown', handleKeyDown);
        return () => {
            doc.removeEventListener('keydown', handleKeyDown);
        };
    }, [viewMode]);

    useEffect(() => {
        const fetchData = () => {
            setSyncEvents([...index.getCalendarEventsForDate(dateKey)].sort((left, right) =>
                left.event.start.localeCompare(right.event.start) || left.event.title.localeCompare(right.event.title)));
            const syncIndex = index.calendarEventIndex;
            setNotes(index.getNotesForDate(dateKey).map(note => ({
                ...note,
                status: syncIndex?.getByPath(note.path)?.status,
            })));
            setRanges(index.getRangesForDate(dateKey));
            setTasks(index.getTasksForDate(dateKey));
            setHolidays(index.getHolidaysForDate(dateKey));
            const status = index.getDateStatus(dateKey);
            setHasDailyNote(status.isDailyNote);
        };

        fetchData();

        const unsubscribe = index.subscribe((changedDates) => {
            if (changedDates === null || changedDates.includes(dateKey)) {
                fetchData();
            }
        });

        return () => unsubscribe();
    }, [dateKey, index]);

    const [year, month, day] = dateKey.split('-').map(Number);
    const targetDate = new Date(year, month - 1, day);
    const today = new Date();
    const todayNormalized = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const daysFromToday = Math.round((targetDate.getTime() - todayNormalized.getTime()) / (1000 * 60 * 60 * 24));

    let relativeText = `${daysFromToday} days from today`;
    if (daysFromToday === 0) relativeText = 'Today';
    else if (daysFromToday === 1) relativeText = 'Tomorrow';
    else if (daysFromToday === -1) relativeText = 'Yesterday';

    const getSymbolForNote = (noteTags: string[]) => {
        if (!noteTags || !settings || !settings.tagAppearance) return null;
        for (const tag of noteTags) {
            if (settings.tagAppearance[tag] && settings.tagAppearance[tag].symbol) {
                return settings.tagAppearance[tag].symbol;
            }
        }
        return null;
    };

    const handleTaskComplete = async (task: TaskNote) => {
        const file = app.vault.getAbstractFileByPath(task.path);
        if (file instanceof TFile) {
            try {
                await app.fileManager.processFrontMatter(file, (frontmatter) => {
                    // Check for recurrence
                    if (frontmatter['recurrence']) {
                        let rruleStr = String(frontmatter['recurrence']);

                        // 1. Handle complete_instances
                        if (!frontmatter['complete_instances']) {
                            frontmatter['complete_instances'] = [];
                        }
                        const completionDate = format(new Date(), 'yyyy-MM-dd');
                        // Ensure it's an array
                        if (Array.isArray(frontmatter['complete_instances'])) {
                            frontmatter['complete_instances'].push(completionDate);
                        }

                        // 2. Calculate duration between scheduled and due
                        let durationDays = 0;
                        const scheduledStr = frontmatter['scheduled'] || frontmatter['due']; // fallback
                        const dueStr = frontmatter['due'];

                        let scheduledDate: Date | null = null;

                        if (scheduledStr) {
                            scheduledDate = parseISO(scheduledStr);
                            // Normalize to midnight for consistent RRule calc
                            scheduledDate.setHours(0, 0, 0, 0);

                            if (dueStr) {
                                const dueDate = parseISO(dueStr);
                                dueDate.setHours(0, 0, 0, 0);
                                durationDays = differenceInDays(dueDate, scheduledDate);
                            }
                        }

                        // 3. Calculate next occurrence using RRule
                        if (scheduledDate) {
                            // Strip DTSTART if present (logic from RecurrenceManager)
                            if (rruleStr.startsWith('DTSTART')) {
                                const semi = rruleStr.indexOf(';');
                                if (semi > -1) rruleStr = rruleStr.substring(semi + 1);
                            }

                            try {
                                const options = RRule.parseString(rruleStr);

                                // Check valid COUNT limit against complete_instances
                                if (options.count && frontmatter['complete_instances'].length >= options.count) {
                                    frontmatter['status'] = 'done';
                                    frontmatter['completedDate'] = format(new Date(), 'yyyy-MM-dd');
                                } else {
                                    // Prepare for next date calc
                                    // Remove COUNT from options so it doesn't reset the counter "from now"
                                    // We rely on the absolute limit check above. 
                                    // UNTIL is preserved in options and handled by rule.after()
                                    if (options.count) delete options.count;

                                    options.dtstart = scheduledDate;
                                    const rule = new RRule(options);

                                    // Get next date after the current scheduled date
                                    const nextDate = rule.after(scheduledDate);

                                    if (nextDate) {
                                        const nextScheduledStr = format(nextDate, 'yyyy-MM-dd');
                                        frontmatter['scheduled'] = nextScheduledStr;

                                        // 4. Update Due Date
                                        if (dueStr) {
                                            const nextDueDate = addDays(nextDate, durationDays);
                                            frontmatter['due'] = format(nextDueDate, 'yyyy-MM-dd');
                                        }
                                    } else {
                                        // No more occurrences (e.g. hit UNTIL)
                                        frontmatter['status'] = 'done';
                                        frontmatter['completedDate'] = format(new Date(), 'yyyy-MM-dd');
                                    }
                                }
                            } catch (e) {
                                console.error("Failed to parse recurrence rule:", e);
                            }
                        }

                    } else {
                        // Non-recurring: Original behavior
                        frontmatter['status'] = 'done';
                        frontmatter['completedDate'] = format(new Date(), 'yyyy-MM-dd');
                    }
                });
            } catch (error) {
                console.error("Failed to update task status:", error);
            }
        }
    };

    // Filter tasks for display (Open OR Completed on this day)
    const displayTasks = tasks.filter(t => {
        if (t.status === 'open' || t.status === 'todo') return true;

        // If completed, only show if it was completed ON THIS DAY
        if (t.completedDate === dateKey) return true;
        if (t.complete_instances && Array.isArray(t.complete_instances)) {
            if (t.complete_instances.includes(dateKey)) return true;
        }
        return false;
    });

    const displayTaskPaths = new Set(displayTasks.map(t => t.path));
    const filteredRanges = ranges.filter(r => !displayTaskPaths.has(r.path));
    const syncEventPaths = new Set(syncEvents.flatMap(event => [
        ...(event.notePath ? [event.notePath] : []),
        ...(event.notePaths ?? []),
    ]));
    const filteredNotes = notes.filter(n => !displayTaskPaths.has(n.path) && !syncEventPaths.has(n.path));

    const handleEditSyncEvent = (syncEvent: CalendarDisplayEvent) => {
        const providerWriteKey = getCalendarEventEditKey(syncEvent);
        if (!providerWriteKey) return;
        if (onEditSyncEvent) {
            onEditSyncEvent(syncEvent.key);
            return;
        }

        const plugin = (app as any).plugins?.getPlugin?.('obsidian-Continuous-calendar')
            || (app as any).plugins?.plugins?.['obsidian-Continuous-calendar']
            || (app as any).plugins?.getPlugin?.('obsidian-continuous-calendar')
            || (app as any).plugins?.plugins?.['obsidian-continuous-calendar'];
        if (plugin?.openCalendarEventEditor) {
            plugin.openCalendarEventEditor(syncEvent.key);
            return;
        }

        const sync = syncSettings;
        const timezone = syncEvent.event.timezone || sync?.timezone || 'UTC';
        openSyncEventModal(app, {
            initialEvent: syncEvent.event,
            timezone,
            onSubmit: async (event) => {
                if (plugin?.updateCalendarEvent) {
                    await plugin.updateCalendarEvent(providerWriteKey, event);
                }
            },
        });
    };

    return (
        <div ref={containerRef} className="day-detail-view">
            {viewMode === 'Continuous' && (
                <div className="day-detail-nav">
                    <div className="nav-buttons">
                        <button onClick={onPrev} className="control-btn" title="Previous Day">
                            &larr; Previous
                        </button>
                        <button onClick={onNext} className="control-btn" title="Next Day">
                            Next &rarr;
                        </button>
                    </div>
                    <button onClick={onClose} className="close-btn" title="Close">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            )}

            <div className="day-detail-header">
                <h2>{format(targetDate, 'EEEE, MMMM dd, yyyy')}</h2>
                <p className="day-detail-relative">{relativeText}</p>
                <button
                    className={`daily-note-btn ${hasDailyNote ? 'open-note' : 'create-note'}`}
                    onClick={() => onOpenNote(dateKey)}
                >
                    {hasDailyNote ? 'Open Daily Note' : 'Create Daily Note'}
                </button>
            </div>

            {filteredRanges.length > 0 && (
                <div className="day-detail-section">
                    <h3>Ongoing Events</h3>
                    <ul className="day-detail-list">
                        {filteredRanges.map((range, idx) => {
                            const symbol = getSymbolForNote(range.tags);
                            let rangeColor = range.color;
                            if (!rangeColor && range.tags && settings?.tagAppearance) {
                                for (const tag of range.tags) {
                                    if (settings.tagAppearance[tag] && settings.tagAppearance[tag].color) {
                                        rangeColor = settings.tagAppearance[tag].color;
                                        break;
                                    }
                                }
                            }
                            return (
                                <li key={idx} className="day-detail-row">
                                    <div className="day-detail-row-title-group">
                                        <a
                                            href="#"
                                            className="internal-link day-detail-row-title"
                                            style={{ color: convertTintToTextColor(rangeColor) || convertTintToTextColor(settings?.defaultBarColor) }}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                app.workspace.openLinkText(range.path, '', false);
                                            }}
                                        >
                                            {symbol && <span className="note-symbol" style={{ marginRight: '6px' }}>{symbol}</span>}
                                            {range.name}
                                        </a>
                                    </div>
                                    <div className="day-detail-row-meta">{range.dateStart} → {range.dateEnd}</div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {displayTasks.length > 0 && (
                <div className="day-detail-section">
                    <h3>Tasks</h3>
                    <ul className="day-detail-list task-list">
                        {displayTasks.map((task, idx) => {
                            let taskColor = task.color;
                            // Fallback to tag color if no explicit color
                            if (!taskColor && task.tags && settings?.tagAppearance) {
                                for (const tag of task.tags) {
                                    if (settings.tagAppearance[tag] && settings.tagAppearance[tag].color) {
                                        taskColor = settings.tagAppearance[tag].color;
                                        break;
                                    }
                                }
                            }

                            // Determine if this instance is completed
                            let isCompletedInstance = false;
                            if (task.completedDate === dateKey) isCompletedInstance = true;
                            if (task.complete_instances && task.complete_instances.includes(dateKey)) isCompletedInstance = true;

                            return (
                                <li key={idx} className="task-item" style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--background-modifier-border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <input
                                            type="checkbox"
                                            checked={isCompletedInstance}
                                            onChange={() => !isCompletedInstance && handleTaskComplete(task)} // Only allow checking off, not unchecking for now (simpler logic)
                                            style={{ cursor: 'pointer' }}
                                            disabled={isCompletedInstance}
                                        />
                                        <a
                                            href="#"
                                            className="internal-link"
                                            style={{
                                                fontWeight: 'normal',
                                                color: convertTintToTextColor(taskColor) || 'var(--text-normal)',
                                                textDecoration: isCompletedInstance ? 'line-through' : 'none',
                                                opacity: isCompletedInstance ? 0.7 : 1
                                            }}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                app.workspace.openLinkText(task.path, '', false);
                                            }}
                                        >
                                            {task.name}
                                        </a>
                                        {task.isRecurring && (
                                            <span className="recurrence-symbol" style={{ fontSize: '0.8em', opacity: 0.7 }}>↻</span>
                                        )}
                                        {task.priority && !isCompletedInstance && (
                                            <span className="task-priority" style={{ fontSize: '0.7em', padding: '2px 4px', borderRadius: '4px', backgroundColor: 'var(--background-secondary)', color: 'var(--text-muted)' }}>
                                                {task.priority}
                                            </span>
                                        )}
                                    </div>
                                    <div className="task-meta" style={{ fontSize: '0.85em', color: 'var(--text-muted)', paddingLeft: '24px' }}>
                                        {isCompletedInstance ? (
                                            <span style={{ color: 'var(--text-success)' }}>Completed</span>
                                        ) : (
                                            task.due && (() => {
                                                // 1. Construct Dates
                                                const [dYear, dMonth, dDay] = task.due.split('-').map(Number);
                                                const dueDate = new Date(dYear, dMonth - 1, dDay);
                                                // Ensure we have scheduled date for range logic, default to due if missing (though usually present for ranges)
                                                const scheduledStr = task.scheduled || task.due;
                                                const [sYear, sMonth, sDay] = scheduledStr.split('-').map(Number);
                                                const scheduledDate = new Date(sYear, sMonth - 1, sDay);

                                                // Real Today
                                                const now = new Date();
                                                const realToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

                                                // Target (Viewing) Date
                                                const [tYear, tMonth, tDay] = dateKey.split('-').map(Number);
                                                const targetDate = new Date(tYear, tMonth - 1, tDay);

                                                const ONE_DAY = 1000 * 60 * 60 * 24;

                                                let label = 'Due:';
                                                let relative = '';
                                                let isErrorColor = false;

                                                // Helper to get days diff (A - B)
                                                const getDiffDays = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / ONE_DAY);

                                                const todayTime = realToday.getTime();
                                                const scheduledTime = scheduledDate.getTime();
                                                const dueTime = dueDate.getTime();
                                                const targetTime = targetDate.getTime();

                                                // Logic Branching
                                                if (todayTime < scheduledTime) {
                                                    // Case 1: Real Today < Scheduled (Future Task)
                                                    if (targetTime >= scheduledTime && targetTime <= dueTime) {
                                                        // "3 days task 1/3" (Duration + Progress)
                                                        const duration = getDiffDays(dueDate, scheduledDate) + 1;
                                                        const dayNum = getDiffDays(targetDate, scheduledDate) + 1;
                                                        relative = `(${duration} days task ${dayNum}/${duration})`;
                                                    } else if (targetTime > dueTime) {
                                                        // "will be due by"
                                                        const diff = getDiffDays(targetDate, dueDate);
                                                        if (diff === 1) relative = '(will be due by 1 day)';
                                                        else relative = `(will be due by ${diff} days)`;
                                                        isErrorColor = true; // Implied overdue relative to target
                                                    }
                                                } else if (todayTime >= scheduledTime && todayTime <= dueTime) {
                                                    // Case 2: Scheduled <= Real Today <= Due (Active Task)
                                                    if (targetTime >= scheduledTime && targetTime <= dueTime) {
                                                        // "in X days" (Distance Today -> Due)
                                                        const diff = getDiffDays(dueDate, realToday);
                                                        if (diff === 0) relative = 'today';
                                                        else if (diff === 1) relative = 'tomorrow';
                                                        else relative = `(in ${diff} days)`;
                                                    } else if (targetTime > dueTime) {
                                                        // "will be due by"
                                                        const diff = getDiffDays(targetDate, dueDate);
                                                        if (diff === 1) relative = '(will be due by 1 day)';
                                                        else relative = `(will be due by ${diff} days)`;
                                                        isErrorColor = true;
                                                    }
                                                } else {
                                                    // Case 3: Real Today > Due (Overdue Task)
                                                    if (targetTime >= scheduledTime && targetTime <= todayTime) {
                                                        // Distance from Today to Overdue
                                                        const diff = getDiffDays(realToday, dueDate);
                                                        if (diff === 1) relative = 'yesterday';
                                                        else relative = `(${diff} days ago)`;
                                                        label = 'Overdue:';
                                                        isErrorColor = true;
                                                    } else if (targetTime > todayTime) {
                                                        // "will be due by" (Simulating looking back from future)
                                                        const diff = getDiffDays(targetDate, dueDate);
                                                        relative = `(will be due by ${diff} days)`;
                                                        isErrorColor = true;
                                                    }
                                                }

                                                // Fallback for dates before scheduled (if they show up)
                                                if (!relative) {
                                                    const diff = getDiffDays(dueDate, targetDate);
                                                    if (diff > 0) relative = `(in ${diff} days)`;
                                                }

                                                // Hide explicit date if relative is immediate
                                                const showDate = !['today', 'tomorrow', 'yesterday'].includes(relative);

                                                return (
                                                    <span style={{ color: isErrorColor ? 'var(--text-error)' : 'inherit', marginRight: '8px' }}>
                                                        {label} {showDate ? task.due : ''} {relative}
                                                    </span>
                                                );
                                            })()
                                        )}
                                        {task.projects && task.projects.length > 0 && (
                                            <span className="task-projects">
                                                {task.projects.map((proj, pIdx) => {
                                                    const projName = proj.replace('[[', '').replace(']]', '');
                                                    return (
                                                        <span key={pIdx}>
                                                            <a
                                                                href="#"
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    app.workspace.openLinkText(projName, '', false);
                                                                }}
                                                                style={{ color: 'var(--text-accent)', marginRight: '4px' }}
                                                            >
                                                                {projName}
                                                            </a>
                                                        </span>
                                                    );
                                                })}
                                            </span>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {(syncEvents.length > 0 || (canWriteSyncEvents && onCreateSyncEvent && canCreateSyncEvent)) && (
                <div className="day-detail-section sync-events-section">
                    <div className="sync-events-header">
                        <h3>Google Calendar events</h3>
                        {canWriteSyncEvents && onCreateSyncEvent && canCreateSyncEvent && (
                            <button
                                className="sync-event-create-icon-btn clickable-icon"
                                onClick={() => onCreateSyncEvent(dateKey)}
                                aria-label="Create Google Calendar event"
                                title="Create Google Calendar event"
                            >
                                <ObsidianIcon icon="plus" />
                            </button>
                        )}
                    </div>
                    {syncEvents.length > 0 && (
                        <ul className="day-detail-list">
                            {syncEvents.map(syncEvent => {
                                const noteActions = getCalendarEventNoteRowActions(
                                    syncEvent,
                                    dateKey,
                                    Boolean(onCreateEventNote),
                                );
                                const editKey = getCalendarEventEditKey(syncEvent);
                                const canDeleteEvent = Boolean(
                                    canWriteSyncEvents && onDeleteSyncEvent && editKey &&
                                    syncEvent.status !== 'unsupported',
                                );
                                const eventTitle = syncEvent.event.title || 'Untitled event';
                                const openCreateNoteScopeModal = () => openSyncNoteScopeModal(app, {
                                    eventTitle: syncEvent.event.title,
                                    scopes: noteActions.createNoteScopes,
                                    selectedDate: dateKey,
                                    recurring: Boolean(syncEvent.masterRemoteId || syncEvent.scope === 'series'),
                                    onSelect: scope => onCreateEventNote?.(
                                        syncEvent.key,
                                        scope,
                                        scope === 'occurrence-day' ? dateKey : undefined,
                                    ),
                                });
                                const titleActionHint = noteActions.titleAction === 'open'
                                    ? 'Click to open linked note.'
                                    : 'Click to choose a linked note.';
                                const scopeActionHint = noteActions.createNoteScopes.length > 0
                                    ? ' Right-click or press Shift+F10 to create another linked note.'
                                    : '';
                                return (
                                    <li key={`${syncEvent.key}:${syncEvent.event.start}`} className="sync-event-card">
                                        <div className="sync-event-card-content">
                                            <div className="sync-event-title-group">
                                                {noteActions.titleAction !== 'none' ? (
                                                    <a
                                                        href="#"
                                                        className="internal-link sync-event-title sync-event-linked-title"
                                                        title={`${titleActionHint}${scopeActionHint}`}
                                                        aria-label={`${eventTitle}. ${titleActionHint}${scopeActionHint}`}
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            const openNote = (path: string) => {
                                                                app.workspace.openLinkText(path, '', false);
                                                            };
                                                            if (noteActions.titleAction === 'open') {
                                                                openNote(noteActions.notePaths[0]);
                                                            } else {
                                                                openSyncLinkedNoteModal(app, {
                                                                    eventTitle: syncEvent.event.title,
                                                                    notePaths: noteActions.notePaths,
                                                                    onSelect: openNote,
                                                                });
                                                            }
                                                        }}
                                                        onContextMenu={e => {
                                                            if (noteActions.createNoteScopes.length === 0) return;
                                                            e.preventDefault();
                                                            openCreateNoteScopeModal();
                                                        }}
                                                        onKeyDown={e => {
                                                            if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))
                                                                && noteActions.createNoteScopes.length > 0) {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                openCreateNoteScopeModal();
                                                            }
                                                        }}
                                                    >
                                                        {eventTitle}
                                                    </a>
                                                ) : (
                                                    <span className="sync-event-title">
                                                        {syncEvent.event.title || 'Untitled event'}
                                                    </span>
                                                )}
                                                <SyncStatusIcon status={syncEvent.status} />
                                                <SyncProjectionStatusIcons event={syncEvent} />
                                            </div>
                                            <div className="sync-event-card-meta">
                                                <div className="sync-event-time" title="Canonical event time">
                                                    {formatCalendarEventTime(syncEvent.event)}
                                                </div>
                                                {(noteActions.showCreateNote || (canWriteSyncEvents && editKey && syncEvent.status !== 'unsupported') || canDeleteEvent) && (
                                                    <div className="sync-event-actions">
                                                        {noteActions.showCreateNote && (
                                                            <button
                                                                type="button"
                                                                className="sync-event-action clickable-icon"
                                                                onClick={openCreateNoteScopeModal}
                                                                aria-label={`Create linked note for ${syncEvent.event.title || 'Untitled event'}`}
                                                                title="Create linked note"
                                                            >
                                                                <ObsidianIcon icon="file-plus" />
                                                            </button>
                                                        )}
                                                        {canWriteSyncEvents && editKey && syncEvent.status !== 'unsupported' && (
                                                            <button
                                                                type="button"
                                                                className="sync-event-action clickable-icon"
                                                                onClick={() => handleEditSyncEvent(syncEvent)}
                                                                aria-label={`Edit ${syncEvent.event.title || 'Untitled event'}`}
                                                                title={`Edit ${syncEvent.event.title || 'Untitled event'}`}
                                                            >
                                                                <ObsidianIcon icon="pencil" />
                                                            </button>
                                                        )}
                                                        {canDeleteEvent && (
                                                            <button
                                                                type="button"
                                                                className="sync-event-action clickable-icon mod-warning"
                                                                onClick={() => {
                                                                    if (editKey && onDeleteSyncEvent) void onDeleteSyncEvent(syncEvent.key);
                                                                }}
                                                                aria-label={`Delete Google Calendar ${syncEvent.masterRemoteId ? 'series' : 'event'} ${syncEvent.event.title || 'Untitled event'}`}
                                                                title={`Delete Google Calendar ${syncEvent.masterRemoteId ? 'series' : 'event'}`}
                                                            >
                                                                <ObsidianIcon icon="trash" />
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}

            {filteredNotes.length > 0 && (
                <div className="day-detail-section">
                    <h3>Notes</h3>
                    <ul className="day-detail-list">
                        {filteredNotes.map((note, idx) => {
                            const symbol = note.symbol || getSymbolForNote(note.tags);
                            let noteColor = note.color;
                            if (!noteColor && note.tags && settings?.tagAppearance) {
                                for (const tag of note.tags) {
                                    if (settings.tagAppearance[tag] && settings.tagAppearance[tag].color) {
                                        noteColor = settings.tagAppearance[tag].color;
                                        break;
                                    }
                                }
                            }

                            return (
                                <li key={idx} className="day-detail-row">
                                    <div className="day-detail-row-title-group">
                                        <a
                                            href="#"
                                            className="internal-link day-detail-row-title"
                                            style={{ color: convertTintToTextColor(noteColor) || convertTintToTextColor(settings?.defaultDotColor) }}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                app.workspace.openLinkText(note.path, '', false);
                                            }}
                                        >
                                            {symbol && <span className="note-symbol" style={{ marginRight: '6px' }}>{symbol}</span>}
                                            {note.name}
                                            {note.isRecurring && (
                                                <span className="recurrence-symbol" style={{ marginLeft: '6px', fontSize: '0.9em', opacity: 0.8 }}>↻</span>
                                            )}
                                        </a>
                                        {note.status && <SyncStatusIcon status={note.status} />}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {holidays.length > 0 && (
                <div className="day-detail-section">
                    <h3>Holidays</h3>
                    <ul className="day-detail-list">
                        {holidays.map((holiday, idx) => (
                            <li key={idx} style={{ color: holiday.color }}>
                                <span>
                                    {holiday.countryCode
                                        ? `${holiday.name} (${holiday.countryCode})`
                                        : holiday.name}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {notes.length === 0 && syncEvents.length === 0 && ranges.length === 0 && tasks.length === 0 && holidays.length === 0 && (
                <p className="day-detail-empty">No events, notes, tasks, or holidays for this day.</p>
            )}
        </div>
    );
};
