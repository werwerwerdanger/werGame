// 单个音符的运行时包装：持有移动节点、贝塞尔曲线、关键点节点与共享落点，
// 负责沿曲线飞行与回收。节点来自 NoteManager 的对象池，回收时归还池。
// 与旧 prework/Note.ts 行为一致，但写成清晰的数据/行为类，不内嵌池管理。

import { Node, Sprite, Color, tween } from 'cc';
import { Bezier } from './Bezier';
import { ParsedNote } from '../core/ChartParser';
import { getLayoutScale } from '../util/layout';
import { NodePoolEx } from '../util/pool';

export class NoteObject {
    ord: number;
    data: ParsedNote;
    curve: Bezier;
    node: Node;                 // 移动中的音符头
    endNode: Node;              // 共享落点（由 EndNodeManager 传入）
    startNode: Node | null = null;
    middleNodes: Node[] = [];
    hit = false;

    private notePool: NodePoolEx;
    private keyPointPool: NodePoolEx;

    constructor(
        ord: number,
        data: ParsedNote,
        endNode: Node,
        noteNode: Node,
        startNode: Node | null,
        middleNodes: Node[],
        notePool: NodePoolEx,
        keyPointPool: NodePoolEx,
    ) {
        this.ord = ord;
        this.data = data;
        this.endNode = endNode;
        this.node = noteNode;
        this.startNode = startNode;
        this.middleNodes = middleNodes;
        this.notePool = notePool;
        this.keyPointPool = keyPointPool;

        const scale = getLayoutScale();
        const skp = data.keypoint.map(v => v * scale);
        this.curve = new Bezier(skp);
        this.node.position = this.curve.getPoint(0);
    }

    /** 沿曲线移动到落点，durationSec 后触发 onArrive（用于自动 Miss 检测） */
    startMove(durationSec: number, onArrive: () => void): void {
        const end = this.endNode.position;
        tween(this.node)
            .to(durationSec, { x: end.x, y: end.y }, {
                onUpdate: (_target: any, ratio: number) => {
                    this.node.position = this.curve.getPoint(ratio);
                },
            })
            .call(() => onArrive())
            .start();
    }

    /** 淡出并回收音符头与关键点（落点由 EndNodeManager 决定是否回收） */
    recycle(fadeSec: number): void {
        const fadeKp = (n: Node) => {
            const s = n.getComponent(Sprite);
            if (s) {
                tween(s).to(fadeSec, { color: new Color(255, 255, 255, 0) })
                    .call(() => this.keyPointPool.put(n)).start();
            } else {
                this.keyPointPool.put(n);
            }
        };
        const sp = this.node.getComponent(Sprite);
        if (sp) {
            tween(sp).to(fadeSec, { color: new Color(255, 255, 255, 0) })
                .call(() => this.notePool.put(this.node)).start();
        } else {
            this.notePool.put(this.node);
        }
        if (this.startNode) fadeKp(this.startNode);
        this.middleNodes.forEach(fadeKp);
    }
}
