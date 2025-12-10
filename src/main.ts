import { Plugin, WorkspaceLeaf } from "obsidian";
import { CalendarView, VIEW_TYPE_CALENDAR } from "./CalendarView";

export default class ContinuousCalendarPlugin extends Plugin {
    async onload() {
        // 1. Register the View
        this.registerView(
            VIEW_TYPE_CALENDAR,
            (leaf) => new CalendarView(leaf)
        );

        // 2. Add Ribbon Icon
        this.addRibbonIcon("calendar-days", "Open Calendar", () => {
            this.activateView();
        });

        // 3. Add Command
        this.addCommand({
            id: "open-calendar-view",
            name: "Open Continuous Calendar",
            callback: () => {
                this.activateView();
            },
        });
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);

        if (leaves.length > 0) {
            // A leaf already exists, use it
            leaf = leaves[0];
        } else {
            // Create a new leaf in the RIGHT sidebar
            leaf = workspace.getRightLeaf(false);

            // FIX 1: Check if leaf exists before using it
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
            }
        }

        // FIX 2: Check if leaf exists before revealing
        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }
}