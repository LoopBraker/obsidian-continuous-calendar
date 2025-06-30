// src/modal.ts
import { App, Modal } from "obsidian";

// Interface defining the parameters for the confirmation dialog
interface IConfirmationDialogParams {
  cta: string; // Call-to-action button text (e.g., "Create")
  // Callback function to execute when the CTA button is clicked
  // It receives the original mouse event if needed and should be async
  onAccept: (e: MouseEvent) => Promise<void>;
  text: string; // The main message/question in the modal body
  title: string; // The title of the modal window
}

// The actual Modal class
export class ConfirmationModal extends Modal {
  config: IConfirmationDialogParams;

  // Store the configuration passed to the constructor
  constructor(app: App, config: IConfirmationDialogParams) {
    super(app);
    this.config = config;
  }

  // This method is called when the modal is opened
  onOpen() {
    const { contentEl } = this;
    const { cta, onAccept, text, title } = this.config; // Use stored config

    contentEl.empty(); // Clear any previous content

    contentEl.createEl("h2", { text: title }); // Set the title
    contentEl.createEl("p", { text }); // Set the body text

    // Create a container for the buttons
    contentEl.createDiv("modal-button-container", (buttonsEl) => {
      // "Cancel" button - simply closes the modal
      buttonsEl
        .createEl("button", { text: "Never mind" })
        .addEventListener("click", () => this.close());

      // "Accept" (Call-to-action) button
      buttonsEl
        .createEl("button", {
          cls: "mod-cta", // Use Obsidian's styling for primary action buttons
          text: cta,
        })
        .addEventListener("click", async (e) => {
          // When clicked, call the async onAccept function passed in the config
          await onAccept(e);
          // Close the modal automatically after the action is performed
          this.close();
        });
    });
  }

  // This method is called when the modal is closed
  onClose() {
    const { contentEl } = this;
    contentEl.empty(); // Clean up the content
  }
}

// Helper function to easily create and open the modal
export function createConfirmationDialog(
  app: App, // Pass the App instance explicitly
  config: IConfirmationDialogParams
): void {
  // Create a new instance of our modal class and open it
  new ConfirmationModal(app, config).open();
}
