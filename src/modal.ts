// src/modal.ts
import { App, Modal } from "obsidian";

interface IConfirmationDialogParams {
  cta: string;
  onAccept: (e: MouseEvent) => Promise<void>;
  text: string;
  title: string;
}

export class ConfirmationModal extends Modal {
  config: IConfirmationDialogParams;

  constructor(app: App, config: IConfirmationDialogParams) {
    super(app);
    this.config = config;
  }

  onOpen() {
    const { contentEl } = this;
    const { cta, onAccept, text, title } = this.config;

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
        .addEventListener("click", async (e) => {
          await onAccept(e);
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
  config: IConfirmationDialogParams
): void {
  new ConfirmationModal(app, config).open();
}