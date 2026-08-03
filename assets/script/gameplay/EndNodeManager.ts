// 落点(EndNode)管理：每个 endpointname 一个共享落点节点；per-endpointname 绑定一次触控；
// 维护"待判定 note 列表"，触控时调用 JudgeSystem 解析命中，并负责 tracker 清理与自动 Miss。
// 旧 remorebettergame1.ts 里的 EndNode 查找/创建/绑定/NoteTracker 全收拢到这里。

import { Node, Sprite, Color, tween, NodeEventType } from 'cc';
import { ParsedNote } from '../core/ChartParser';
import { NoteObject } from './NoteObject';
import { PendingNote, resolveTouch, isAutoMiss } from '../core/JudgeSystem';
import { JudgeRecord } from '../core/types';

export class EndNodeManager {
    private parent: Node;
    private nodes = new Map<string, Node>();
    private trackers = new Map<string, PendingNote[]>();
    private bound = new Set<string>();

    constructor(parent: Node) {
        this.parent = parent;
    }

    /** 取得或创建落点节点（per-endpointname 共享）。位置由调用方随后设置 */
    createOrGet(name: string): Node {
        let n = this.nodes.get(name);
        if (n) return n;
        n = new Node(name);
        n.setParent(this.parent);
        n.addComponent(Sprite).color = new Color(255, 255, 255, 0);
        this.nodes.set(name, n);
        return n;
    }

    /** 仅当该落点尚未绑定时绑定 TOUCH_END -> onTouch(endpointname) */
    bindTouch(name: string, onTouch: (ep: string) => void): void {
        if (this.bound.has(name)) return;
        const n = this.nodes.get(name);
        if (!n) return;
        this.bound.add(name);
        n.on(NodeEventType.TOUCH_END, () => onTouch(name), this);
    }

    /** 注册一个可玩 note 到对应落点的待判定列表 */
    register(p: ParsedNote, note: NoteObject): void {
        let arr = this.trackers.get(p.endpointname);
        if (!arr) { arr = []; this.trackers.set(p.endpointname, arr); }
        arr.push({ ord: p.ord, endtime: p.endtime, hit: false, ctx: note });
    }

    /** 处理某落点的触控，返回命中结果（含 NoteObject），无命中返回 null */
    handleTouch(name: string, elapsedMs: number): { record: JudgeRecord; note: NoteObject } | null {
        const arr = this.trackers.get(name);
        if (!arr) return null;
        const out = resolveTouch(elapsedMs, arr);
        if (!out) return null;
        const note = out.pending.ctx as NoteObject;
        this.cleanup(name, arr);
        return { record: out.record, note };
    }

    /** 自动 Miss 检测：超窗且未命中才返回 NoteObject 并清理 */
    autoMiss(name: string, ord: number, elapsedMs: number): NoteObject | null {
        const arr = this.trackers.get(name);
        if (!arr) return null;
        const entry = arr.find(e => e.ord === ord);
        if (!entry || entry.hit) return null;
        if (!isAutoMiss(elapsedMs, entry)) return null;
        entry.hit = true;
        const note = entry.ctx as NoteObject;
        this.cleanup(name, arr);
        return note;
    }

    /** 落点淡入（endPointOrNot 时调用） */
    fadeInEnd(name: string, alpha: number): void {
        const n = this.nodes.get(name);
        if (!n) return;
        const s = n.getComponent(Sprite);
        if (!s) return;
        tween(s).to(0.05, { color: new Color(255, 255, 255, Math.round(255 * alpha)) }).start();
    }

    private cleanup(name: string, arr: PendingNote[]): void {
        const remaining = arr.filter(e => !e.hit);
        if (remaining.length === 0) this.trackers.delete(name);
        else this.trackers.set(name, remaining);
    }

    reset(): void {
        this.nodes.forEach(n => n.destroy());
        this.nodes.clear();
        this.trackers.clear();
        this.bound.clear();
    }
}
