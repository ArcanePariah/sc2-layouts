import * as util from 'util';
import { oentries } from '../common';
import { LayoutDocument, Store } from './store';
import { XMLElement, XMLNode, DiagnosticReport, XMLDocument } from '../types';
import * as sch from '../schema/base';
import { DescSelect, SelectionFragment, SelectionFragmentKind, BuiltinHandleKind } from '../parser/selector';

export class DescXRef {
    readonly name: string;
    declarations = new Set<XMLElement>();

    constructor(name: string) {
        this.name = name;
    }

    isOrphan() {
        return this.declarations.size === 0;
    }

    // addDecl(el: XMLElement) {
    //     this.declarations.add(el);
    // }
}

export class DescXRefMap<T extends DescXRef> extends Map<string, T> {
    protected descGroup = new Map<XMLDocument, Set<XMLElement>>();
    protected nodeIndex = new Map<XMLElement, T>();

    constructor(protected itemType: { new (name: string): T; }, protected indexAttrKey = 'name') {
        super();
    }

    appendOrCreate(el: XMLElement, xdoc: XMLDocument) {
        const key = el.getAttributeValue(this.indexAttrKey);
        let item = this.get(key);
        if (!item) {
            item = new this.itemType(key);
            this.set(key, item);
        }

        item.declarations.add(el);
        this.nodeIndex.set(el, item);

        //
        if (!xdoc) xdoc = el.getDocument();
        let descGroupEntry = this.descGroup.get(xdoc);
        if (!descGroupEntry) {
            descGroupEntry = new Set<XMLElement>();
            this.descGroup.set(xdoc, descGroupEntry);
        }
        descGroupEntry.add(el);
    }

    removeOrDestroy(el: XMLElement) {
        // const key = el.getAttributeValue(this.indexAttrKey);
        // let item = this.get(key);
        let item = this.nodeIndex.get(el);
        if (item) {
            this.nodeIndex.delete(el);
            item.declarations.delete(el);
            if (item.isOrphan()) {
                this.delete(item.name);
            }
        }
    }

    purgeDocumentDecls(xdoc: XMLDocument) {
        const entries = this.descGroup.get(xdoc);
        if (!entries) return;
        for (const item of entries) {
            this.removeOrDestroy(item);
        }
        this.descGroup.delete(xdoc);
    }
}

export class ConstantItem extends DescXRef {}
export class HandleItem extends DescXRef {}

// ===

export const enum DescKind {
    Undeclared,
    Root,
    File,
    Frame,
    Animation,
    StateGroup,
}

export class DescNamespace {
    kind: DescKind;
    parent?: DescNamespace;
    readonly name: string;
    readonly children = new Map<string, DescNamespace>();
    readonly xDecls = new Set<XMLNode>();

    constructor(name: string, kind = DescKind.Undeclared, parent?: DescNamespace) {
        this.name = name;
        this.kind = kind;
        if (parent) {
            this.parent = parent;
            parent.children.set(name, this);
        }
    }

    getOrCreate(name: string, kind: DescKind) {
        let tmp = this.children.get(name);
        if (!tmp) {
            tmp = new DescNamespace(name, kind, this);
        }
        return tmp;
    }

    purgeOrphansDeep() {
        for (const tmp of this.children.values()) {
            tmp.purgeOrphansDeep();
        }
        if (this.children.size) return;
        this.parent.children.delete(this.name);
        this.parent = void 0;
    }

    get(name: string) {
        return this.children.get(name);
    }

    getDeep(name: string) {
        const parts = name.split('/');
        if (parts.length === 0) return void 0;

        let tmp: DescNamespace = this;
        let i = 0;
        while (tmp && i < parts.length) {
            tmp = tmp.children.get(parts[i]);
            ++i;
        }
        return tmp;
    }

    get fqn(): string {
        return (this.parent && this.parent.kind !== DescKind.Root) ? `${this.parent.fqn}/${this.name}` : this.name;
    }

    get stype() {
        return Array.from(this.xDecls.values())[0].stype;
    }

    get template() {
        const tmp = Array.from(this.xDecls.values())[0];
        return (<XMLElement>tmp).getAttributeValue('template', null);
    }

    get file() {
        const tmp = Array.from(this.xDecls.values())[0];
        return (<XMLElement>tmp).getAttributeValue('file', null);
    }
}

export class DocumentState {
    readonly xdeclDescMap = new Map<XMLNode, DescNamespace>();

    constructor(public readonly xdoc: XMLDocument) {
    }
}

function getDeclDescKind(xdecl: XMLElement) {
    switch (xdecl.sdef.nodeKind) {
        case sch.ElementDefKind.Frame:
            return DescKind.Frame;
        case sch.ElementDefKind.Animation:
            return DescKind.Animation;
        case sch.ElementDefKind.StateGroup:
            return DescKind.StateGroup;
    }
    throw new Error();
}

export class DescIndex {
    protected xdocState: Map<XMLDocument, DocumentState>;
    rootNs: DescNamespace;
    tplRefs: Map<string, Set<DescNamespace>>;

    constants: DescXRefMap<ConstantItem>;
    handles: DescXRefMap<HandleItem>;

    constructor() {
        this.clear();
    }

    public clear() {
        this.xdocState = new Map<XMLDocument, DocumentState>();
        this.rootNs = new DescNamespace('$root', DescKind.Root);
        this.tplRefs = new Map();

        this.constants = new DescXRefMap<ConstantItem>(ConstantItem, 'name');
        this.handles = new DescXRefMap<HandleItem>(HandleItem, 'val');
    }

    protected bindWorker(parentNs: DescNamespace, currXNode: XMLElement, docState: DocumentState) {
        if (!currXNode.sdef || !currXNode.stype) return;

        const isInFDesc = parentNs.kind === DescKind.File;

        switch (currXNode.sdef.nodeKind) {
            case sch.ElementDefKind.Animation:
            case sch.ElementDefKind.StateGroup:
            case sch.ElementDefKind.Frame:
            {
                const name = currXNode.getAttributeValue('name', null);
                if (name === null) break;
                const currDesc = parentNs.getOrCreate(name, getDeclDescKind(currXNode));
                currDesc.xDecls.add(currXNode);
                docState.xdeclDescMap.set(currXNode, currDesc);

                // TODO: validate type
                // currEl.getAttributeValue('type')
                // currEl.getAttributeValue('file')

                // track templates
                const tpl = currXNode.getAttributeValue('template', null);
                if (tpl) {
                    let trefs = this.tplRefs.get(tpl);
                    if (!trefs) {
                        trefs = new Set();
                        this.tplRefs.set(tpl, trefs);
                    }
                    trefs.add(currDesc);
                }

                //
                if (currXNode.sdef.nodeKind === sch.ElementDefKind.Frame) {
                    for (const xsub of currXNode.children) {
                        this.bindWorker(currDesc, xsub, docState);
                    }
                }

                break;
            }

            case sch.ElementDefKind.Constant:
            {
                this.constants.appendOrCreate(currXNode, docState.xdoc);
                return;
            }

            case sch.ElementDefKind.FrameProperty:
            {
                const natVal = currXNode.stype.attributes.get('val');
                if (!natVal) return;
                switch (natVal.type.builtinType) {
                    case sch.BuiltinTypeKind.Handle:
                    {
                        this.handles.appendOrCreate(currXNode, docState.xdoc);
                        break;
                    }
                }
                return;
            }

            default:
            {
                // console.log(`# unknown ${currXNode.tag}[${currXNode.stype.name}]`);
                return;
            }
        }
    }

    bindDocument(doc: LayoutDocument) {
        const docState = new DocumentState(doc);
        this.xdocState.set(doc, docState);

        const fiDesc = this.rootNs.getOrCreate(doc.descName, DescKind.File);
        docState.xdeclDescMap.set(doc, fiDesc);

        for (const xsub of doc.getDescNode().children) {
            this.bindWorker(fiDesc, xsub, docState);
        }
    }

    unbindDocument(doc: LayoutDocument) {
        this.constants.purgeDocumentDecls(doc);
        this.handles.purgeDocumentDecls(doc);

        const docState = this.xdocState.get(doc);
        for (const [xDecl, descNode] of docState.xdeclDescMap) {
            descNode.xDecls.delete(xDecl);

            switch (descNode.kind) {
                case DescKind.Frame:
                case DescKind.Animation:
                {
                    const tpl = (<XMLElement>xDecl).getAttributeValue('template', null);
                    if (tpl) {
                        const trefs = this.tplRefs.get(tpl)
                        trefs.delete(descNode);
                        if (!trefs.size) {
                            this.tplRefs.delete(tpl);
                        }
                    }
                }
            }
        }

        for (const descNode of docState.xdeclDescMap.values()) {
            if (descNode.xDecls.size) continue;
            if (!descNode.parent) continue;
            descNode.purgeOrphansDeep();
        }
        this.xdocState.delete(doc);
    }

    resolveSelectionFragment(sef: SelectionFragment, dcontext: DescNamespace, first = false): DescNamespace {
        switch (sef.kind) {
            case SelectionFragmentKind.BuiltinHandle:
            {
                switch (sef.builtinHandle) {
                    case BuiltinHandleKind.Root:
                    {
                        if (!first) return void 0;
                        let currd = dcontext;
                        while (currd.parent) {
                            currd = currd.parent;
                        }
                        return currd;
                    }

                    case BuiltinHandleKind.This:
                    {
                        return dcontext;
                    }

                    case BuiltinHandleKind.Parent:
                    {
                        return dcontext.parent;
                    }

                    case BuiltinHandleKind.Layer:
                    case BuiltinHandleKind.Ancestor:
                    case BuiltinHandleKind.Sibling:
                    {
                        // TODO:
                        return void 0;
                    }
                }
                break;
            }

            case SelectionFragmentKind.CustomHandle:
            {
                if (!first) return void 0;
                // TODO:
                break;
            }

            case SelectionFragmentKind.Identifier:
            {
                return dcontext.children.get(sef.identifier);
                break;
            }
        }
        return void 0;
    }

    resolveSelection(sel: DescSelect, dcontext: DescNamespace): DescNamespace {
        let currd = dcontext;
        for (const slfrag of sel.fragments) {
            currd = this.resolveSelectionFragment(slfrag, currd, currd === dcontext);
            if (!currd) break;
        }
        return currd;
    }

    resolveElementDesc(xEl: XMLElement, kind: DescKind = null) {
        const docState = this.xdocState.get(xEl.getDocument());
        do {
            const elDesc = docState.xdeclDescMap.get(xEl)
            if (elDesc && (kind === null || elDesc.kind === kind)) return elDesc;
        } while(xEl = <XMLElement>xEl.parent);
    }
}
