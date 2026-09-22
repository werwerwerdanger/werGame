// 音符管理器：负责精灵资源预加载、对象池、按谱面条目生成 NoteObject。
// 旧工程的 MyPool + Note 构造里的资源/池逻辑统一收拢到这里，GameDirector 不再碰资源细节。

import { Node, Sprite, SpriteFrame, resources, Color, tween, Tween } from 'cc';
import { NoteObject } from './NoteObject';
import { ParsedNote } from '../core/ChartParser';
import { NodePoolEx } from '../util/pool';
import { NoteKind } from '../core/types';
import { getLayoutScale } from '../util/layout';

const NOTE_IMG: Record<NoteKind, string> = {
    tap: 'NoteImage/tap/spriteFrame',
    flick: 'NoteImage/Flick/spriteFrame',
    drag: 'NoteImage/Drag/spriteFrame',
};
// 关键点贴图：起点/中间点/落点 统一用一张材质（endimage）
const KP_BODY = 'keypointimage/endimage/spriteFrame';
const KP_END = KP_BODY;

export class NoteManager {
    private parent: Node;
    private notePool = new NodePoolEx(() => new Node(), 300);
    private keyPool = new NodePoolEx(() => new Node(), 400);
    private frames: Record<string, SpriteFrame> = {};
    private loaded = false;
    private active: NoteObject[] = [];

    constructor(parent: Node) {
        this.parent = parent;
    }

    /** 预加载所有用到的 spriteframe（异步），完成后 loaded=true */
    preload(): Promise<void> {
        const paths = [...Object.keys(NOTE_IMG).map(k => NOTE_IMG[k as NoteKind]), KP_BODY, KP_END];
        return Promise.all(paths.map(p => this.loadFrame(p))).then(() => {
            this.loaded = true;
        });
    }

    private loadFrame(path: string): Promise<SpriteFrame> {
        return new Promise((resolve, reject) => {
            resources.load(path, SpriteFrame, (err, sf) => {
                if (err || !sf) { reject(err); return; }
                this.frames[path] = sf;
                resolve(sf);
            });
        });
    }

    private getNoteNode(kind: NoteKind): Node {
        const node = this.notePool.get();
        const sf = this.frames[NOTE_IMG[kind]];
        let sp = node.getComponent(Sprite);
        if (!sp) sp = node.addComponent(Sprite);
        sp.spriteFrame = sf;
        sp.color = new Color(255, 255, 255, 255);
        node.name = 'Note_' + kind;
        return node;
    }

    private getKeyNode(isEnd: boolean): Node {
        const node = this.keyPool.get();
        const sf = this.frames[isEnd ? KP_END : KP_BODY];
        let sp = node.getComponent(Sprite);
        if (!sp) sp = node.addComponent(Sprite);
        sp.spriteFrame = sf;
        sp.color = new Color(255, 255, 255, 0); // 关键点默认透明，由 fadeIn 点亮
        node.name = isEnd ? 'EndNode' : 'KeyPoint';
        return node;
    }

    /** 生成一个音符及其关键点节点，返回 NoteObject（落点 endNode 由外部传入） */
    spawn(p: ParsedNote, endNode: Node, trackOn: boolean, sizeScale: number): NoteObject {
        const noteNode = this.getNoteNode(p.kind);
        noteNode.setParent(this.parent);
        noteNode.setScale(sizeScale, sizeScale, 1);

        const scale = getLayoutScale();
        const skp = p.keypoint.map(v => v * scale);
        const pointNum = skp.length / 2;
        const middleNum = Math.max(0, pointNum - 2);

        let startNode: Node | null = null;
        if (p.startPointOrNot) {
            startNode = this.getKeyNode(false);
            startNode.setParent(this.parent);
            startNode.position.set(skp[0], skp[1], 0);
        }
        const middleNodes: Node[] = [];
        for (let i = 0; i < middleNum; i++) {
            const m = this.getKeyNode(false);
            m.setParent(this.parent);
            m.position.set(skp[2 + i * 2], skp[3 + i * 2], 0);
            middleNodes.push(m);
        }

        // 每 note 独立的落点关键点：带角度、不依赖共享 EndNode（共享节点不能按 note 转角）
        const last = skp.length - 2;
        let endKeyNode: Node | null = null;
        if (p.endPointOrNot) {
            endKeyNode = this.getKeyNode(true);
            endKeyNode.setParent(this.parent);
            endKeyNode.position.set(skp[last], skp[last + 1], 0);
        }

        if (!trackOn) {
            // 关闭轨道显示：关键点保持透明
            const hide = (n: Node) => { const s = n.getComponent(Sprite); if (s) s.color = new Color(255, 255, 255, 0); };
            if (startNode) hide(startNode);
            middleNodes.forEach(hide);
        } else {
            const alphaTarget = p.opacity / 255;
            const fadeIn = (n: Node) => {
                const s = n.getComponent(Sprite);
                if (s) tween(s).to(0.05, { color: new Color(255, 255, 255, Math.round(255 * alphaTarget)) }).start();
            };
            if (startNode && p.startPointOrNot) fadeIn(startNode);
            if (p.middlePointOrNot) middleNodes.forEach(fadeIn);
        }

        // 落点关键点：endPointOrNot 即显示（与共享 EndNode 的 fadeInEnd 一致，不依赖 trackOn）
        if (endKeyNode) {
            const s = endKeyNode.getComponent(Sprite);
            if (s) tween(s).to(0.05, { color: new Color(255, 255, 255, Math.round(255 * (p.opacity / 255))) }).start();
        }

        const note = new NoteObject(p.ord, p, endNode, noteNode, startNode, middleNodes, endKeyNode, this.notePool, this.keyPool);
        this.active.push(note);
        return note;
    }

    /** 回收一个音符并移出活跃列表（由 GameDirector 在判定后调用，替代直接 note.recycle） */
    recycleNote(note: NoteObject, fadeSec: number): void {
        const i = this.active.indexOf(note);
        if (i >= 0) this.active.splice(i, 1);
        note.recycle(fadeSec);
    }

    /** 暂停所有活跃音符的移动/淡出 Tween（暂停游戏用） */
    pauseAll(): void {
        for (const n of this.active) Tween.pauseAllByTarget(n.node);
    }

    /** 恢复所有活跃音符的 Tween */
    resumeAll(): void {
        for (const n of this.active) Tween.resumeAllByTarget(n.node);
    }

    get isLoaded(): boolean { return this.loaded; }
}
