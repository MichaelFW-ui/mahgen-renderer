import { Plugin, MarkdownView } from 'obsidian';
import { Mahgen } from 'Mahgen';
import { ViewPlugin, Decoration, ViewUpdate, DecorationSet, EditorView, WidgetType, PluginSpec } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

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
        img.style.height = this.options.height;
        img.style.width = this.options.width || 'auto';
        return img;
    }
}

class MahgenViewPlugin {
    protected decorations: DecorationSet;  // 改为 protected
    private cache: Map<string, string>; // Cache for rendered content

    constructor(view: EditorView) {
        this.cache = new Map();
        this.decorations = this.buildDecorations(view);
    }

    // 添加 getter 方法
    getDecorations(): DecorationSet {
        return this.decorations;
    }

    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = this.buildDecorations(update.view);
        }
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
        const renderContent = this.cache.get(source) || '';
        
        if (this.cache.has(source)) {
            this.createDecoration(builder, start, end, renderContent);
        } else {
            Mahgen.render(source, false)
                .then(content => {
                    this.cache.set(source, content);
                    this.createDecoration(builder, start, end, content);
                })
                .catch(error => console.error('Mahgen rendering error:', error));
        }
    }

    private createDecoration(builder: RangeSetBuilder<Decoration>, start: number, end: number, content: string) {
        builder.add(start, end, Decoration.widget({
            widget: new MahgenWidget(content, { height: '2.5em' }),
            side: 1
        }));
    }
}

export default class MarkdownMahgenPlugin extends Plugin {
    private extension: ViewPlugin<MahgenViewPlugin>[] = [];

    async onload() {
        this.registerMarkdownProcessors();
        this.setupEditorExtension();
        this.registerLayoutChangeHandler();
    }

    private registerMarkdownProcessors() {
        this.registerMarkdownCodeBlockProcessor('mahgen', this.processMahgenBlock.bind(this));
        this.registerMarkdownCodeBlockProcessor('mahgen-river', 
            (source, el, ctx) => this.processMahgenBlock(source, el, ctx, true)
        );
        this.registerMarkdownPostProcessor(this.handleInlineCode.bind(this));
    }

    private setupEditorExtension() {
        const viewPlugin = ViewPlugin.fromClass(MahgenViewPlugin, {
            decorations: value => value.getDecorations()  // 使用 getter 方法
        });
        this.extension.push(viewPlugin);
        this.registerEditorExtension(this.extension);
    }

    private registerLayoutChangeHandler() {
        this.app.workspace.on('layout-change', () => {
            const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
            this.extension = markdownView?.getState().source ? [] : this.extension;
            this.app.workspace.updateOptions();
        });
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

    private async renderMahgenContent(source: string, element: HTMLElement, context: any, isRiver = false) {
        try {
            const content = await Mahgen.render(source, isRiver);
            const img = this.createImage(content, {
                height: isRiver ? this.calculateRiverHeight(source) : '2.5em'
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
        img.style.height = options.height;
        img.style.width = options.width || 'auto';
        return img;
    }

    private calculateRiverHeight(source: string): string {
        const digitCount = (source.match(/\d/g) || []).length;
        return `${(digitCount / 6) * 3.2}em`;
    }

    private async processMahgenBlock(source: string, el: HTMLElement, ctx: any, isRiver = false) {
        await this.renderMahgenContent(source, el, ctx, isRiver);
    }
}
