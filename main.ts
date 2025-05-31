import { Plugin, MarkdownView, editorLivePreviewField } from 'obsidian';
import { Mahgen } from 'mahgen';
import { ViewPlugin, Decoration, ViewUpdate, DecorationSet, EditorView, WidgetType, PluginSpec } from '@codemirror/view';
import { RangeSetBuilder, StateField } from '@codemirror/state';

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

class MahgenViewPlugin {
    protected decorations: DecorationSet;  // Changed to protected
    private cache: Map<string, string>; // Cache for rendered content

    constructor(view: EditorView) {
        this.cache = new Map();
        this.decorations = this.buildDecorations(view);
    }

    // Add getter method
    getDecorations(): DecorationSet {
        return this.decorations;
    }

    update(update: ViewUpdate) {
        // Check if in live preview mode
        const livePreviewState = update.state.field(editorLivePreviewField, false);
        
        // If not in live preview mode, clear all decorations
        if (!livePreviewState) {
            this.decorations = Decoration.none;
            return;
        }

        // Only update decorations in live preview mode
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
        const renderContent: string = this.cache.get(source) || '';
        
        if (this.cache.has(source)) {
            this.createDecoration(builder, start, end, renderContent);
        } else {
            Mahgen.render(source, false)
                .then((content: string) => {
                    this.cache.set(source, content);
                    this.createDecoration(builder, start, end, content);
                })
                .catch((error: Error) => console.error('Mahgen rendering error:', error));
        }
    }

    private createDecoration(builder: RangeSetBuilder<Decoration>, start: number, end: number, content: string) {
        builder.add(start, end, Decoration.widget({
            widget: new MahgenWidget(content, { 
                height: getComputedStyle(document.documentElement).getPropertyValue('--mahgen-base-height').trim(),
                isRiver: false 
            }),
            side: 1
        }));
    }
}

export default class MarkdownMahgenPlugin extends Plugin {
    private extension: ViewPlugin<MahgenViewPlugin>[] = [];

    async onload() {
        this.registerMarkdownProcessors();
        this.setupEditorExtension();
    }

    private registerMarkdownProcessors() {
        this.registerMarkdownCodeBlockProcessor('mahgen', this.processMahgenBlock.bind(this));
        this.registerMarkdownCodeBlockProcessor('mahgen-river',
            (source, el, ctx) => this.processMahgenBlock(source, el, ctx, true)
        );
        this.registerMarkdownCodeBlockProcessor('nankiru', this.processNankiruBlock.bind(this));
        this.registerMarkdownPostProcessor(this.handleInlineCode.bind(this));
    }

    private setupEditorExtension() {
        const viewPlugin = ViewPlugin.fromClass(MahgenViewPlugin, {
            decorations: value => value.getDecorations()  // Use getter method
        });
        this.extension.push(viewPlugin);
        this.registerEditorExtension(this.extension);
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
                height: isRiver ? this.calculateRiverHeight(source) : '2.5em',
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
            img.classList.add('mahgen-image');
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
        
        // 环境信息部分
        const envSpan = document.createElement('span');
        envSpan.classList.add('nankiru-env');
        envSpan.textContent = `「${envParts.join(' ')}」`;
        infoDiv.appendChild(envSpan);
        
        // 宝牌渲染
        if (doraPart) {
            try {
                const doraContent = await Mahgen.render(doraPart, false);
                const doraImg = document.createElement('img');
                doraImg.src = doraContent;
                doraImg.classList.add('mahgen-image', 'nankiru-dora');
                infoDiv.appendChild(doraImg);
            } catch (error) {
                console.error('宝牌渲染错误:', error);
            }
        }
        
        container.appendChild(infoDiv);

        // 第三行: 手牌
        const handLine = lines[2].trim();
        try {
            const handContent = await Mahgen.render(handLine, false);
            const handImg = document.createElement('img');
            handImg.src = handContent;
            handImg.classList.add('mahgen-image', 'nankiru-hand');
            container.appendChild(handImg);
        } catch (error) {
            console.error('手牌渲染错误:', error);
        }

        // 第四行: 答案 (仅当题号以A开头时显示)
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
                answerImg.classList.add('mahgen-image', 'nankiru-answer-hand');
                answerDiv.appendChild(answerImg);
                
                container.appendChild(answerDiv);
            } catch (error) {
                console.error('答案渲染错误:', error);
            }
        }

        el.replaceWith(container);
    }
}
