import { App, AbstractInputSuggest, TFile, prepareFuzzySearch } from 'obsidian';

/**
 * Tag suggester for auto-completing tag names
 */
export class TagSuggest extends AbstractInputSuggest<string> {
    private allTags: string[];

    constructor(app: App, private inputEl: HTMLInputElement) {
        super(app, inputEl);

        // Get all tags from the vault by scanning all files
        this.allTags = this.getAllTags();

        // Listen for input to show suggestions
        this.inputEl.addEventListener('input', this.onInput.bind(this));
        this.inputEl.addEventListener('focus', this.onInput.bind(this));
    }

    private getAllTags(): string[] {
        const tags = new Set<string>();
        const files = this.app.vault.getMarkdownFiles();

        files.forEach((file: TFile) => {
            const cache = this.app.metadataCache.getFileCache(file);
            const fileTags = cache?.tags || [];
            const frontmatterTags = cache?.frontmatter?.tags || [];

            // Add inline tags
            fileTags.forEach(tagRef => {
                if (tagRef.tag) {
                    tags.add(tagRef.tag);
                }
            });

            // Add frontmatter tags
            if (Array.isArray(frontmatterTags)) {
                frontmatterTags.forEach(tag => {
                    const normalized = tag.startsWith('#') ? tag : `#${tag}`;
                    tags.add(normalized);
                });
            }
        });

        return Array.from(tags);
    }

    onInput() {
        if (!this.inputEl.value) {
            this.close();
            return;
        }
        this.open();
    }

    getSuggestions(query: string): string[] {
        if (!query) {
            return this.allTags.slice(0, 50);
        }

        // Simple fuzzy matching - check if all characters of query appear in order
        const lowerQuery = query.toLowerCase();
        return this.allTags.filter(tag => {
            const lowerTag = tag.toLowerCase();
            let tagIndex = 0;
            for (let i = 0; i < lowerQuery.length; i++) {
                tagIndex = lowerTag.indexOf(lowerQuery[i], tagIndex);
                if (tagIndex === -1) return false;
                tagIndex++;
            }
            return true;
        }).slice(0, 50); // Limit results
    }

    renderSuggestion(tag: string, el: HTMLElement): void {
        el.setText(tag);
    }

    selectSuggestion(tag: string, evt: MouseEvent | KeyboardEvent): void {
        this.inputEl.value = tag;
        this.inputEl.dispatchEvent(new Event('input'));
        this.close();
    }
}
