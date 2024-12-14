import { Plugin, Workspace, MarkdownView, MarkdownViewModeType, editorLivePreviewField } from 'obsidian';
import { Mahgen } from 'Mahgen';
import { ViewPlugin, Decoration, ViewUpdate, DecorationSet, EditorView, WidgetType, PluginSpec } from '@codemirror/view';

import { RangeSetBuilder, EditorState } from '@codemirror/state';

class EmojiWidget extends WidgetType {
    toDOM(view: EditorView): HTMLElement {
        const div = document.createElement("span");
        div.innerText = "👉";
        return div;
    }
}


        class MahgenPlugin {
            decorations: DecorationSet;
            cache: Map<string, string>; // 添加一个 Map 用于缓存结果

            constructor(view: EditorView) {
                this.cache = new Map(); // 初始化 Map
                // console.log('MahgenPlugin initialized', this.cache);
                this.decorations = this.buildDecorations(view);
            }

            update(update: ViewUpdate) {
                if (
                    update.docChanged ||
                    update.viewportChanged ||
                    update.selectionSet
                ) {

                    // console.log(update)
                    this.decorations = this.buildDecorations(update.view);
                }
            }

            buildDecorations(view: EditorView): DecorationSet {
                const builder = new RangeSetBuilder<Decoration>();

                for (let { from, to } of view.visibleRanges) {
                    const text = view.state.doc.sliceString(from, to);
                    const regex = /`(mahgen|mg)\s+([^`]+)`/g;
                    let match;
                    while ((match = regex.exec(text)) !== null) {
                        const start = from + match.index;
                        const end = start + match[0].length;
                        const source = match[2];
                        const selection = view.state.selection;

                        // 检查当前光标是否在特定范围内
                        const isCursorInRange = selection.ranges.some(range => {
                            const cursorStart = range.from;
                            const cursorEnd = range.to;

                            // 这里可以定义您要检查的特定范围
                            const specificStart = start; // 例如，开始位置
                            const specificEnd = end;   // 例如，结束位置

                            return (cursorStart >= specificStart && cursorEnd <= specificEnd);
                        });

                        // 如果光标在特定范围内，则不渲染装饰
                        if (isCursorInRange) {
                            // console.log('Cursor is within the specific range, skipping decorations.');
                            return builder.finish(); // 直接返回空的装饰
                        }
                        // 检查匹配的内容是否跨越多行
                        const startLine = view.state.doc.lineAt(start);
                        const endLine = view.state.doc.lineAt(end);

                        if (startLine.number !== endLine.number) {
                            // console.warn('Decoration cannot cross multiple lines');
                            continue; // 如果跨越多行，跳过这个装饰
                        }

                        // 检查缓存中是否存在渲染结果
                        if (this.cache.has(source)) {
                            const renderedContent = this.cache.get(source);
                            this.addDecoration(builder, start, end, renderedContent);
                        } else {
                            // 调用 Mahgen.render 渲染内容
                            Mahgen.render(source, false).then((renderedContent: string) => {
                                // 缓存渲染结果
                                this.cache.set(source, renderedContent);
                                this.addDecoration(builder, start, end, renderedContent);
                            }).catch(error => {
                                console.error('Error rendering Mahgen block:', error);
                            });
                        }
                    }
                }

                return builder.finish();
            }

            // 添加装饰的辅助函数
            addDecoration(builder: RangeSetBuilder<Decoration>, start: number, end: number, renderedContent: string) {
                const img = new Image();
                img.src = renderedContent;
                img.style.height = '2.5em';
                img.style.width = 'auto';

                const decoration = Decoration.widget({
                    widget: new class extends WidgetType {
                        toDOM() {
                            return img;
                        }
                    },
                    side: 1 // 将 widget 插入在行内
                });

                builder.add(start, end, decoration);
            }
        };
export default class MarkdownMahgenPlugin extends Plugin {
    extension: ViewPlugin<MahgenPlugin>[] = [];
    async onload() {
        console.log('Loading Mahgen Plugin');

        this.registerMarkdownCodeBlockProcessor('mahgen', this.processMahgenBlock.bind(this));
        this.registerMarkdownCodeBlockProcessor('mahgen-river', this.processMahgenRiverBlock.bind(this));

        // 注册 CodeMirror 6 扩展，用于在 live preview 中处理行内代码渲染
        // this.registerEditorExtension(this.createMahgenInlineProcessor());
        // this.app.workspace.updateOptions();
        const viewPlugin = this.createMahgenInlineProcessor();

        this.app.workspace.on('layout-change', () => {
            const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView)?.getState();
            this.extension.length = 0;
            if (!(markdownView.source)) {
              this.extension.push(viewPlugin);
            }
            this.app.workspace.updateOptions();
          })
          this.registerEditorExtension(this.extension)

        console.log("注册Markdown后处理器");
        this.registerMarkdownPostProcessor((element: HTMLElement, context: any) => {
            // 查找所有行内代码块

            const codeBlocks: NodeListOf<HTMLElement> = element.querySelectorAll('code');
            for (let index = 0; index < codeBlocks.length; index++) {
                // 遍历每个行内代码块
                const codeBlock = codeBlocks.item(index);
                const content: string = codeBlock.innerText;
                // console.log(content);

                // 检查行内代码块是否以 'mahgen' 或 'mg' 开头
                let match = content.match(/^(mahgen|mg)( |$)/);
                if (match) {
                    const prefixLength = match[1].length;
                    const source: string = content.slice(prefixLength).trim();
                    processMahgenBlock(source, codeBlock, context);
                }
            }
        });
        // 定义处理函数
        async function processMahgenBlock(source: string, el: HTMLElement, ctx: any): Promise<void> {
            try {
                const renderedContent: string = await Mahgen.render(source, false);
                const img: HTMLImageElement = document.createElement('img');
                img.src = renderedContent;

                // 设置图片高度与字体高度相同，宽度自动调整以保持比例
                img.style.height = '2.5em';
                img.style.width = 'auto';
                el.innerHTML = '';
                // el.appendChild(img);
                el.replaceWith(img);
            } catch (error) {
                console.error('Error rendering Mahgen block:', error);
                el.createEl('div', { text: 'Error rendering Mahgen block. Check console for details.' });
            }
        }
    }

    onunload() {
        console.log('Unloading Mahgen Plugin');
    }

    // 创建 CodeMirror 扩展来处理行内代码
    createMahgenInlineProcessor() {

        const MahgenPluginSpec: PluginSpec<MahgenPlugin> = {
            decorations: (value: MahgenPlugin) => value.decorations
        };
        return ViewPlugin.fromClass(MahgenPlugin, MahgenPluginSpec);
    }

    async processMahgenBlock(source: string, el: HTMLElement, ctx: any) {
        try {
            const renderedContent = await Mahgen.render(source, false);
            const img = document.createElement('img');
            img.src = renderedContent;
            img.style.height = '2.5em';
            img.style.width = 'auto';
            el.appendChild(img);
        } catch (error) {
            console.error('Error rendering Mahgen block:', error);
            el.createEl('div', { text: 'Error rendering Mahgen block. Check console for details.' });
        }
    }

    async processMahgenRiverBlock(source: string, el: HTMLElement, ctx: any) {
        try {
            const renderedContent = await Mahgen.render(source, true);
            const img = document.createElement('img');
            img.src = renderedContent;
            img.style.height = this.calculateHeightFromSource(source);
            img.style.width = 'auto';
            el.appendChild(img);
        } catch (error) {
            console.error('Error rendering Mahgen block:', error);
            el.createEl('div', { text: 'Error rendering Mahgen block. Check console for details.' });
        }
    }

    calculateHeightFromSource(source: string): string {
        const numbers = source.match(/\d/g);
        const totalCount = numbers ? numbers.length : 0;
        const heightFactor = (totalCount / 6) * 3.2;
        return `${heightFactor}em`;
    }
}
