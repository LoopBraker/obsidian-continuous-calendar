export class Component {
	load(): void {}
	unload(): void {
		this.onunload();
	}
	onunload(): void {}
	registerDomEvent(el: { addEventListener: (t: string, cb: unknown) => void }, type: string, callback: unknown): void {
		el.addEventListener(type, callback);
	}
}

export function setIcon(el: HTMLElement, _iconId: string): void {
	// No-op for tests
}

export class Notice {
	constructor(public message: string) {}
}

export class Modal {
	constructor(public app: unknown) {}
	open(): void {}
	close(): void {}
}

export class App {}
export class PluginSettingTab {}
export class Setting {}

export class Plugin {
	app: any = new App();
	registerEditorExtension(_ext: any): void {}
	registerEvent(_ref: any): void {}
}

export class TFile {
	path = '';
	basename = '';
	extension = 'md';
}

export class MarkdownView {
	file: TFile | null = null;
	previewMode = { containerEl: document?.createElement?.('div') ?? {} };
	getMode(): string { return 'preview'; }
}

export class WorkspaceLeaf {
	view: any = new MarkdownView();
}

export const editorInfoField = {
	name: 'editorInfoField',
};

export const editorLivePreviewField = {
	name: 'editorLivePreviewField',
};
