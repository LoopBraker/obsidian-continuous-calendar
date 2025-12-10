import { ItemView, WorkspaceLeaf } from "obsidian";
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import ContinuousCalendar from "./ContinuousCalendar";

export const VIEW_TYPE_CALENDAR = "Continuous-calendar-view";

export class CalendarView extends ItemView {
    root: Root | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
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