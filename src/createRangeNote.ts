import { App, TFile, Notice } from "obsidian";

export async function createRangeNote(
    app: App,
    startDate: string,
    endDate: string
): Promise<void> {
    const noteContent = `---
dateStart: ${startDate}
dateEnd: ${endDate}
---

# Range Note: ${startDate} to ${endDate}

`;

    try {
        const fileName = `Range Note ${startDate} to ${endDate}.md`;
        const filePath = fileName;

        // Check if file already exists
        const existingFile = app.vault.getAbstractFileByPath(filePath);
        if (existingFile) {
            new Notice(`Range note already exists: ${fileName}`);
            await app.workspace.openLinkText(filePath, '', false);
            return;
        }

        // Create the file
        const newFile = await app.vault.create(filePath, noteContent);
        new Notice(`Created range note: ${fileName}`);

        // Open the newly created file
        await app.workspace.openLinkText(newFile.path, '', false);
    } catch (err) {
        console.error('Failed to create range note:', err);
        new Notice('Failed to create range note. Check console for details.');
    }
}
