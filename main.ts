import { App, Plugin, PluginSettingTab, Setting, MarkdownView, editorLivePreviewField } from 'obsidian';
import { Mahgen } from 'mahgen';
import { ViewPlugin, Decoration, ViewUpdate, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, Extension } from '@codemirror/state';

const FURIGANA_EXCLUDE_SELECTOR = 'code, pre, ruby';
const FURIGANA_REGEX = /\{([\u3400-\u9FFF\uF900-\uFAFF々〆ヵヶ]+)((?:\|[^|{}\s]+)+)\}/g;

interface FuriganaToken {
    start: number;
    end: number;
    baseUnits: string[];
    readings: string[];
}

interface MarkdownMahgenSettings {
    enableFurigana: boolean;
}

const DEFAULT_SETTINGS: MarkdownMahgenSettings = {
    enableFurigana: false
};

interface ImageRenderOptions {
    height: string;
    width?: string;
    isRiver?: boolean;
}

class MahgenWidget extends WidgetType {
    constructor(private content: string, private options: ImageRenderOptions) {
        super();
    }

    toDOM(): HTMLElement {
        const img = document.createElement('img');
        img.src = this.content;
        if (this.options.isRiver) {
            img.classList.add('mahgen-river-image');
            img.style.setProperty('--mahgen-height', this.options.height);
        } else {
            img.classList.add('mahgen-image');
        }
        return img;
    }
}

function parseFuriganaTokens(text: string): FuriganaToken[] {
    const tokens: FuriganaToken[] = [];
    const regex = new RegExp(FURIGANA_REGEX.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        const baseText = match[1];
        const readings = match[2].split('|').filter(Boolean);
        const baseUnits = readings.length === 1 ? [baseText] : Array.from(baseText);

        if (baseUnits.length !== readings.length) continue;
        if (match.index === undefined) continue;

        tokens.push({
            start: match.index,
            end: match.index + match[0].length,
            baseUnits,
            readings
        });
    }

    return tokens;
}

function createFuriganaRuby(baseUnits: string[], readings: string[]): HTMLElement {
    const ruby = document.createElement('ruby');
    ruby.classList.add('mahgen-furigana-ruby');

    for (let i = 0; i < baseUnits.length; i++) {
        ruby.append(baseUnits[i]);
        const rt = document.createElement('rt');
        rt.textContent = readings[i];
        ruby.append(rt);
    }

    return ruby;
}

class MahgenViewPlugin {
    private static readonly REBUILD_THROTTLE_MS = 80;
    private static readonly MAX_CACHE_SIZE = 500;

    protected decorations: DecorationSet;
    private cache: Map<string, string>;
    private pendingRenders: Map<string, Promise<void>>;
    private view: EditorView;
    private rebuildTimer: number | null;
    private rebuildQueued: boolean;
    private isDestroyed: boolean;

    constructor(view: EditorView) {
        this.view = view;
        this.cache = new Map();
        this.pendingRenders = new Map();
        this.rebuildTimer = null;
        this.rebuildQueued = false;
        this.isDestroyed = false;
        this.decorations = this.buildDecorations(view);
    }

    getDecorations(): DecorationSet {
        return this.decorations;
    }

    update(update: ViewUpdate) {
        this.view = update.view;
        const livePreviewState = update.state.field(editorLivePreviewField, false);

        if (!livePreviewState) {
            this.cancelRebuild();
            this.decorations = Decoration.none;
            return;
        }

        if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.scheduleRebuild();
        }
    }

    destroy() {
        this.isDestroyed = true;
        this.pendingRenders.clear();
        this.cancelRebuild();
    }

    private scheduleRebuild() {
        if (this.rebuildQueued || this.isDestroyed) return;
        this.rebuildQueued = true;
        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildQueued = false;
            this.rebuildTimer = null;
            this.rebuildDecorations();
        }, MahgenViewPlugin.REBUILD_THROTTLE_MS);
    }

    private cancelRebuild() {
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
        this.rebuildQueued = false;
    }

    private rebuildDecorations() {
        if (this.isDestroyed) return;
        this.decorations = this.buildDecorations(this.view);
        this.view.dispatch({});
    }

    private buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        
        for (let { from, to } of view.visibleRanges) {
            const text = view.state.doc.sliceString(from, to);
            const regex = /`(mahgen|mg)\s+([^`]+)`/g;
            let match;

            while ((match = regex.exec(text)) !== null) {
                const start = from + match.index;
                const end = start + match[0].length;
                const source = match[2];

                // Skip decoration if cursor is within the code block
                if (this.isCursorInRange(view, start, end)) continue;

                // Skip multi-line decorations
                if (this.isMultiLine(view, start, end)) continue;

                this.addDecoration(builder, start, end, source);
            }
        }

        return builder.finish();
    }

    private isCursorInRange(view: EditorView, start: number, end: number): boolean {
        return view.state.selection.ranges.some(range => 
            range.from >= start && range.to <= end
        );
    }

    private isMultiLine(view: EditorView, start: number, end: number): boolean {
        return view.state.doc.lineAt(start).number !== view.state.doc.lineAt(end).number;
    }

    private addDecoration(builder: RangeSetBuilder<Decoration>, start: number, end: number, source: string) {
        const renderContent = this.cache.get(source);

        if (renderContent) {
            this.createDecoration(builder, start, end, renderContent);
        } else {
            this.queueRender(source);
        }
    }

    private queueRender(source: string) {
        if (this.pendingRenders.has(source)) return;

        const renderTask = Mahgen.render(source, false)
            .then((content: string) => {
                this.cache.set(source, content);
                this.trimCache();
                this.scheduleRebuild();
            })
            .catch((error: Error) => console.error('Mahgen rendering error:', error))
            .finally(() => {
                this.pendingRenders.delete(source);
            });

        this.pendingRenders.set(source, renderTask);
    }

    private trimCache() {
        while (this.cache.size > MahgenViewPlugin.MAX_CACHE_SIZE) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey === undefined) break;
            this.cache.delete(firstKey);
        }
    }

    private createDecoration(builder: RangeSetBuilder<Decoration>, start: number, end: number, content: string) {
        builder.add(start, end, Decoration.widget({
            widget: new MahgenWidget(content, {
                height: getComputedStyle(document.documentElement).getPropertyValue('--mahgen-inline-height').trim() || '2.5em',
                isRiver: false
            }),
            side: 1
        }));
    }
}

class FuriganaWidget extends WidgetType {
    constructor(
        private baseUnits: string[],
        private readings: string[]
    ) {
        super();
    }

    eq(other: FuriganaWidget): boolean {
        return this.baseUnits.join('\u0000') === other.baseUnits.join('\u0000') &&
            this.readings.join('\u0000') === other.readings.join('\u0000');
    }

    toDOM(): HTMLElement {
        return createFuriganaRuby(this.baseUnits, this.readings);
    }
}

class FuriganaViewPlugin {
    private static readonly REBUILD_THROTTLE_MS = 80;

    decorations: DecorationSet;
    private view: EditorView;
    private rebuildTimer: number | null;
    private rebuildQueued: boolean;
    private isDestroyed: boolean;

    constructor(view: EditorView) {
        this.view = view;
        this.rebuildTimer = null;
        this.rebuildQueued = false;
        this.isDestroyed = false;
        this.decorations = this.isLivePreview(view) ? this.buildDecorations(view) : Decoration.none;
    }

    update(update: ViewUpdate) {
        this.view = update.view;
        if (!this.isLivePreview(update.view)) {
            this.cancelRebuild();
            this.decorations = Decoration.none;
            return;
        }

        if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.scheduleRebuild();
        }
    }

    destroy() {
        this.isDestroyed = true;
        this.cancelRebuild();
    }

    private scheduleRebuild() {
        if (this.rebuildQueued || this.isDestroyed) return;
        this.rebuildQueued = true;
        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildQueued = false;
            this.rebuildTimer = null;
            this.rebuildDecorations();
        }, FuriganaViewPlugin.REBUILD_THROTTLE_MS);
    }

    private cancelRebuild() {
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
        this.rebuildQueued = false;
    }

    private rebuildDecorations() {
        if (this.isDestroyed) return;
        if (!this.isLivePreview(this.view)) {
            this.decorations = Decoration.none;
            this.view.dispatch({});
            return;
        }
        this.decorations = this.buildDecorations(this.view);
        this.view.dispatch({});
    }

    private isLivePreview(view: EditorView): boolean {
        return !!view.state.field(editorLivePreviewField, false);
    }

    private buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();

        for (const { from, to } of view.visibleRanges) {
            const text = view.state.doc.sliceString(from, to);
            const tokens = parseFuriganaTokens(text);
            for (const token of tokens) {
                const start = from + token.start;
                const end = from + token.end;

                if (this.isSelectionOverlapping(view, start, end)) continue;
                if (this.isMultiLine(view, start, end)) continue;

                builder.add(start, end, Decoration.replace({
                    widget: new FuriganaWidget(token.baseUnits, token.readings)
                }));
            }
        }

        return builder.finish();
    }

    private isSelectionOverlapping(view: EditorView, start: number, end: number): boolean {
        return view.state.selection.ranges.some((range) => {
            if (range.from === range.to) {
                return range.from >= start && range.from <= end;
            }
            return range.from < end && range.to > start;
        });
    }

    private isMultiLine(view: EditorView, start: number, end: number): boolean {
        return view.state.doc.lineAt(start).number !== view.state.doc.lineAt(end).number;
    }
}

export default class MarkdownMahgenPlugin extends Plugin {
    private extension: Extension[] = [];
    private settings: MarkdownMahgenSettings = DEFAULT_SETTINGS;

    private readonly mahgenViewPlugin = ViewPlugin.fromClass(MahgenViewPlugin, {
        decorations: value => value.getDecorations()
    });

    private readonly furiganaViewPlugin = ViewPlugin.fromClass(FuriganaViewPlugin, {
        decorations: value => value.decorations
    });

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new MarkdownMahgenSettingTab(this.app, this));

        this.registerMarkdownProcessors();
        this.setupEditorExtension();
    }

    private async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    private async saveSettings() {
        await this.saveData(this.settings);
    }

    async updateFuriganaEnabled(enabled: boolean) {
        if (this.settings.enableFurigana === enabled) return;
        this.settings.enableFurigana = enabled;
        await this.saveSettings();
        this.refreshEditorExtensions();
        this.refreshOpenMarkdownPreviews();
    }

    isFuriganaEnabled(): boolean {
        return this.settings.enableFurigana;
    }

    private registerMarkdownProcessors() {
        this.registerMarkdownCodeBlockProcessor('mahgen', this.processMahgenBlock.bind(this));
        this.registerMarkdownCodeBlockProcessor('mahgen-river',
            (source, el, ctx) => this.processMahgenBlock(source, el, ctx, true)
        );
        this.registerMarkdownCodeBlockProcessor('nankiru', this.processNankiruBlock.bind(this));
        this.registerMarkdownPostProcessor(this.handleInlineCode.bind(this));
        this.registerMarkdownPostProcessor(this.handleFuriganaPostProcessor.bind(this));
    }

    private setupEditorExtension() {
        this.refreshEditorExtensions(false);
        this.registerEditorExtension(this.extension);
    }

    private refreshEditorExtensions(applyWorkspaceUpdate = true) {
        this.extension.length = 0;
        this.extension.push(this.mahgenViewPlugin);

        if (this.settings.enableFurigana) {
            this.extension.push(this.furiganaViewPlugin);
        }

        if (applyWorkspaceUpdate) {
            this.app.workspace.updateOptions();
        }
    }

    private refreshOpenMarkdownPreviews() {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) continue;
            if (view.getMode() !== 'preview') continue;
            view.previewMode.rerender(true);
        }
    }

    private async handleInlineCode(element: HTMLElement, context: any) {
        const codeBlocks = element.querySelectorAll('code');
        for (const codeBlock of Array.from(codeBlocks)) {
            const match = codeBlock.innerText.match(/^(mahgen|mg)( |$)/);
            if (match) {
                const source = codeBlock.innerText.slice(match[1].length).trim();
                await this.renderMahgenContent(source, codeBlock as HTMLElement, context);
            }
        }
    }

    private handleFuriganaPostProcessor(element: HTMLElement) {
        if (!this.settings.enableFurigana) return;
        if (!element.textContent || !element.textContent.includes('{')) return;

        try {
            const textNodes = new Set<Text>();
            this.collectFuriganaTextNodes(element, textNodes);

            for (const textNode of textNodes) {
                this.replaceFuriganaTextNode(textNode);
            }
        } catch (error) {
            console.error('Furigana post processor error:', error);
        }
    }

    private collectFuriganaTextNodes(root: Element, result: Set<Text>) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const textNode = node as Text;
                const parent = textNode.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (!textNode.textContent || !textNode.textContent.includes('{')) return NodeFilter.FILTER_SKIP;
                if (parent.closest(FURIGANA_EXCLUDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        while (walker.nextNode()) {
            result.add(walker.currentNode as Text);
        }
    }

    private replaceFuriganaTextNode(textNode: Text) {
        const text = textNode.textContent;
        if (!text) return;
        if (!text.includes('{')) return;

        const tokens = parseFuriganaTokens(text);
        if (tokens.length === 0) return;

        const fragment = document.createDocumentFragment();
        let cursor = 0;

        for (const token of tokens) {
            if (cursor < token.start) {
                fragment.append(text.slice(cursor, token.start));
            }

            fragment.append(createFuriganaRuby(token.baseUnits, token.readings));
            cursor = token.end;
        }

        if (cursor < text.length) {
            fragment.append(text.slice(cursor));
        }

        textNode.replaceWith(fragment);
    }

    private async renderMahgenContent(source: string, element: HTMLElement, context: any, isRiver = false) {
        try {
            const content = await Mahgen.render(source, isRiver);
            const img = this.createImage(content, {
                height: isRiver ? this.calculateRiverHeight(source) :
                         getComputedStyle(document.documentElement).getPropertyValue('--mahgen-inline-height').trim() || '2.5em',
                isRiver: isRiver
            });
            element.replaceWith(img);
        } catch (error) {
            console.error('Mahgen rendering error:', error);
            element.textContent = 'Error rendering Mahgen block';
        }
    }

    private createImage(src: string, options: ImageRenderOptions): HTMLImageElement {
        const img = document.createElement('img');
        img.src = src;
        if (options.isRiver) {
            img.classList.add('mahgen-river-image');
            img.style.setProperty('--mahgen-height', options.height);
        } else {
            // 后处理器渲染的块级手牌使用 mahgen-block-image
            img.classList.add('mahgen-block-image');
        }
        return img;
    }

    private calculateRiverHeight(source: string): string {
        const digitCount = (source.match(/\d/g) || []).length;
        const rows = Math.ceil(digitCount / 6);
        const rowHeight = getComputedStyle(document.documentElement).getPropertyValue('--mahgen-row-height').trim();
        return `calc(${rows} * ${rowHeight})`;
    }

    private async processMahgenBlock(source: string, el: HTMLElement, ctx: any, isRiver = false) {
        await this.renderMahgenContent(source, el, ctx, isRiver);
    }

    private async processNankiruBlock(source: string, el: HTMLElement, ctx: any) {
        const lines = source.trim().split('\n');
        if (lines.length < 3) return;

        const container = document.createElement('div');
        container.classList.add('nankiru-container');

        // 第一行: 题号 (Q/A + 三位数字)
        const headerLine = lines[0].trim();
        const headerMatch = headerLine.match(/^([QA])(\d{3})$/);
        if (headerMatch) {
            const headerDiv = document.createElement('div');
            headerDiv.classList.add('nankiru-header');
            
            const prefixSpan = document.createElement('span');
            prefixSpan.classList.add('nankiru-prefix');
            if (headerMatch[1] === 'A') {
                prefixSpan.classList.add('nankiru-prefix-answer');
            }
            prefixSpan.textContent = headerMatch[1];
            headerDiv.appendChild(prefixSpan);
            
            const numberSpan = document.createElement('span');
            numberSpan.classList.add('nankiru-number');
            if (headerMatch[1] === 'A') {
                numberSpan.classList.add('nankiru-number-answer');
            }
            numberSpan.textContent = headerMatch[2];
            headerDiv.appendChild(numberSpan);
            
            container.appendChild(headerDiv);
        }

        // 第二行: 环境信息 + 宝牌
        const infoLine = lines[1].trim();
        const infoDiv = document.createElement('div');
        infoDiv.classList.add('nankiru-info');
        
        // 分离环境信息和宝牌
        const parts = infoLine.split(' ');
        const envParts = parts.slice(0, -1); // 环境信息部分
        const doraPart = parts[parts.length - 1]; // 宝牌信息
        
        // Environment information section
        const envSpan = document.createElement('span');
        envSpan.classList.add('nankiru-env');
        envSpan.textContent = `「${envParts.join(' ')}」`;
        infoDiv.appendChild(envSpan);
        
        // Dora tile rendering
        if (doraPart) {
            try {
                const doraContent = await Mahgen.render(doraPart, false);
                const doraImg = document.createElement('img');
                doraImg.src = doraContent;
                doraImg.classList.add('mahgen-block-image', 'nankiru-dora');
                infoDiv.appendChild(doraImg);
            } catch (error) {
                console.error('Dora tile rendering error:', error);
            }
        }
        
        container.appendChild(infoDiv);

        // Third line: Hand tiles
        const handLine = lines[2].trim();
        try {
            const handContent = await Mahgen.render(handLine, false);
            const handImg = document.createElement('img');
            handImg.src = handContent;
            handImg.classList.add('mahgen-block-image', 'nankiru-hand');
            container.appendChild(handImg);
        } catch (error) {
            console.error('手牌渲染错误:', error);
        }

        // Fourth line: Answer (only displayed when the header starts with 'A')
        if (headerMatch && headerMatch[1] === 'A' && lines.length > 3) {
            const answerLine = lines[3].trim();
            try {
                const answerDiv = document.createElement('div');
                answerDiv.classList.add('nankiru-answer');
                
                const arrowSpan = document.createElement('span');
                arrowSpan.classList.add('nankiru-arrow');
                arrowSpan.textContent = '➤';
                answerDiv.appendChild(arrowSpan);
                
                const answerContent = await Mahgen.render(answerLine, false);
                const answerImg = document.createElement('img');
                answerImg.src = answerContent;
                answerImg.classList.add('mahgen-block-image', 'nankiru-answer-hand');
                answerDiv.appendChild(answerImg);
                
                container.appendChild(answerDiv);
            } catch (error) {
                console.error('答案渲染错误:', error);
            }
        }

        el.replaceWith(container);
    }
}

class MarkdownMahgenSettingTab extends PluginSettingTab {
    private plugin: MarkdownMahgenPlugin;

    constructor(app: App, plugin: MarkdownMahgenPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Enable Furigana')
            .setDesc('Parse {漢字|かな} syntax in reading view and Live Preview. Disabled by default to avoid conflicts.')
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.isFuriganaEnabled());
                toggle.onChange(async (value) => {
                    await this.plugin.updateFuriganaEnabled(value);
                });
            });
    }
}
