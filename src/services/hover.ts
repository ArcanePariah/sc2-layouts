import * as util from 'util';
import * as vs from 'vscode';
import * as sch from '../schema/base';
import { AbstractProvider, svcRequest } from './provider';
import { XMLElement } from '../types';

function attrSchDocs(sAttr: sch.Attribute)  {
    let s = '';
    s += `&nbsp;**@**${sAttr.name}${(sAttr.required ? '' : '?')} — [${sAttr.type.name}](#)`;
    if (sAttr.documentation) {
        s += ' — ' + sAttr.documentation;
    }
    return s;
}

export class HoverProvider extends AbstractProvider implements vs.HoverProvider {
    protected matchAttrValueEnum(smType: sch.SimpleType, value: string) {
        value = value.toLowerCase();

        function processSmType(smType: sch.SimpleType): { type: sch.SimpleType, name: string, label?: string } | undefined {
            if (smType.emap) {
                const r = smType.emap.get(value);
                if (!r) return void 0;
                return {
                    type: smType,
                    name: r.name,
                    label: r.label,
                };
            }

            if (smType.union) {
                for (const unSmType of smType.union) {
                    const r = processSmType(unSmType);
                    if (r) return r;
                }
            }
        }

        return processSmType(smType);
    }

    @svcRequest(
        false,
        (document: vs.TextDocument, position: vs.Position) => {
            return {
                filename: document.uri.fsPath,
                position: {line: position.line, char: position.character},
            };
        },
        (r: vs.Hover) => typeof r
    )
    async provideHover(document: vs.TextDocument, position: vs.Position, token: vs.CancellationToken) {
        const sourceFile = await this.svcContext.syncVsDocument(document);

        const offset = document.offsetAt(position);
        const node = sourceFile.findNodeAt(offset);
        let hv: vs.Hover;

        if (node instanceof XMLElement && node.stype) {
            if (node.start <= offset && (node.start + node.tag.length + 1) > offset) {
                if (node.sdef) {
                    let contents = '';
                    contents += `**<${node.sdef.name}>** — [${node.sdef.type.name}](#)`;
                    if (node.sdef.label) {
                        contents += '\n\n' + node.sdef.label;
                    }
                    if (node.stype.label) {
                        contents += `\n\n[${node.stype.name}](#)\\\n` + node.stype.label;
                    }
                    contents += '\n\n' + Array.from(node.stype.attributes.values()).map(v => attrSchDocs(v)).join('\n\n');
                    hv = new vs.Hover(contents.trim());
                }
            }
            else {
                const attr = node.findAttributeAt(offset);
                if (attr) {
                    let scAttr = node.stype.attributes.get(attr.name.toLowerCase());
                    if (!scAttr) {
                        const indType = this.xray.matchIndeterminateAttr(node, attr.name);
                        if (indType) {
                            scAttr = {
                                name: indType.key.name,
                                type: indType.value,
                                required: true,
                            };
                        }
                    }

                    if (scAttr) {
                        if ((attr.start + attr.name.length) > offset) {
                            let contents = attrSchDocs(scAttr);
                            hv = new vs.Hover(
                                new vs.MarkdownString(contents),
                            );
                        }
                        else if (attr.startValue && attr.startValue <= offset) {
                            switch (scAttr.type.builtinType) {
                                default:
                                {
                                    const wordRange = document.getWordRangeAtPosition(position);
                                    const matchedEn = this.matchAttrValueEnum(scAttr.type, document.getText(wordRange));
                                    if (matchedEn && matchedEn.label) {
                                        let contents = `**${matchedEn.name}** — ${matchedEn.label}\n\n[${matchedEn.type.name}](#)`;
                                        hv = new vs.Hover(
                                            new vs.MarkdownString(contents),
                                            wordRange
                                        );
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (token.isCancellationRequested) return void 0;

        return hv;
    }
}
