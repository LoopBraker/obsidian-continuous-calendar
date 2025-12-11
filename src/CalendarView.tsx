import { Plugin, ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import ContinuousCalendar from "./ContinuousCalendar";
import ContinuousCalendarPlugin from "./main";
import { IndexService } from "./services/IndexService";

export const VIEW_TYPE_CALENDAR = "Continuous-calendar-view";

export class CalendarView extends ItemView {
    root: Root | null = null;
    calendarIndex: IndexService;
    plugin: ContinuousCalendarPlugin;

    constructor(leaf: WorkspaceLeaf, index: IndexService, plugin: ContinuousCalendarPlugin) {
        super(leaf);
        this.calendarIndex = index;
        this.plugin = plugin;
    }

    getViewType() {
        return VIEW_TYPE_CALENDAR;
    }

    getDisplayText() {
        return "Continuous Calendar";
    }

    getIcon() {
        return "calendar-days";
    }

    async onOpen() {
        const container = this.containerEl;
        container.empty();

        // Create a wrapper div for React
        const reactRoot = container.createDiv({ cls: "Continuous-calendar-plugin" });
        reactRoot.style.height = "100%";
        reactRoot.style.width = "100%";

        this.root = createRoot(reactRoot);
        this.root.render(
            <React.StrictMode>
                <ContinuousCalendar />
            </React.StrictMode>
        );
    }

    async onClose() {
        this.root?.unmount();
    }
}