import { App, Modal } from "obsidian";

interface ConfirmationDialogParams {
    title: string;
    text: string;
    cta: string;
    onAccept: () => Promise<void>;
}

export class ConfirmationModal extends Modal {
    config: ConfirmationDialogParams;

    constructor(app: App, config: ConfirmationDialogParams) {
        super(app);
        this.config = config;
    }

    onOpen() {
        const { contentEl } = this;
        const { title, text, cta, onAccept } = this.config;

        contentEl.empty();
        contentEl.createEl("h2", { text: title });
        contentEl.createEl("p", { text });

        contentEl.createDiv("modal-button-container", (buttonsEl) => {
            buttonsEl
                .createEl("button", { text: "Never mind" })
                .addEventListener("click", () => this.close());

            buttonsEl
                .createEl("button", {
                    cls: "mod-cta",
                    text: cta,
                })
                .addEventListener("click", async () => {
                    await onAccept();
                    this.close();
                });
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export function createConfirmationDialog(
    app: App,
    config: ConfirmationDialogParams
): void {
    new ConfirmationModal(app, config).open();
}
