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
    endKeyNode: Node | null = null;   // 每 note 独立的落点关键点（带角度，解决共享 EndNode 不能按 note 转角的问题）
    hit = false;

    // ===== 确定性运动（时间参数化，可回溯）=====
    // 与 startMove 的固定 tween 互斥、二选一。位置是时间的纯函数：pos = curve.getPoint(ratio(t))，
    // t 由驱动方每帧传入（游戏时间，可含 judgeOffset 等全局参数）——参数变了所有 note 沿曲线整体滑动，
    // 可前进可回溯，天然支持"拖 offset 滑块时正在飞的 note 实时跟着动"。
    private detStartMs = 0;
    private detDurationMs = 0;
    private detOnArrive: (() => void) | null = null;

    private notePool: NodePoolEx;
    private keyPointPool: NodePoolEx;

    constructor(
        ord: number,
        data: ParsedNote,
        endNode: Node,
        noteNode: Node,
        startNode: Node | null,
        middleNodes: Node[],
        endKeyNode: Node | null,
        notePool: NodePoolEx,
        keyPointPool: NodePoolEx,
    ) {
        this.ord = ord;
        this.data = data;
        this.endNode = endNode;
        this.node = noteNode;
        this.startNode = startNode;
        this.middleNodes = middleNodes;
        this.endKeyNode = endKeyNode;
        this.notePool = notePool;
        this.keyPointPool = keyPointPool;

        const scale = getLayoutScale();
        const skp = data.keypoint.map(v => v * scale);
        this.curve = new Bezier(skp);
        this.node.position = this.curve.getPoint(0);

        // 关键点按 note 角度固定朝向：起点/中间用出发方向 at(0)，落点用到达方向 at(1)
        const ang = this.data.angle;
        const a0 = ang ? ang.at(0) : 0;
        const a1 = ang ? ang.at(1) : 0;
        if (this.startNode) this.startNode.angle = a0;
        this.middleNodes.forEach(m => m.angle = a0);
        if (this.endKeyNode) this.endKeyNode.angle = a1;
    }

    /** 确定性运动启动：只记录出生时刻与时长，不动节点。之后每帧由驱动方调 tick(游戏时间ms)。
     *  nowMs 用什么时钟由驱动方定（预览用 Date.now()-起点，游戏内用同一判定时钟）；
     *  要支持 judgeOffset 实时回溯，就把 offset 折进 tMs 里传进来（t = rawNow + offset）。 */
    startMoveDet(nowMs: number, durationMs: number, onArrive: () => void): void {
        this.detStartMs = nowMs;
        this.detDurationMs = durationMs;
        this.detOnArrive = onArrive;
    }

    /** 每帧由驱动方调用：按当前 tMs 重算曲线位置。offset 改变 → tMs 改变 → note 可进可退（回溯）。
     *  ratio 首次 >=1 触发一次 onArrive（自动 Miss 检测），之后不再重复触发；回收仍由驱动方控制。 */
    tick(tMs: number): void {
        if (this.detDurationMs <= 0) return;
        const ratio = Math.min(1, Math.max(0, (tMs - this.detStartMs) / this.detDurationMs));
        this.node.position = this.curve.getPoint(ratio);
        if (this.data.angle) this.node.angle = this.data.angle.at(ratio);
        if (ratio >= 1 && this.detOnArrive) {
            const cb = this.detOnArrive;
            this.detOnArrive = null; // 防重复触发；回退后再到不重新触发（驱动方需要可自行加标志）
            cb();
        }
    }

    /** 沿曲线移动到落点，durationSec 后触发 onArrive（用于自动 Miss 检测） */
    startMove(durationSec: number, onArrive: () => void): void {
        const end = this.endNode.position;
        tween(this.node)
            .to(durationSec, { x: end.x, y: end.y }, {
                onUpdate: (_target: any, ratio: number) => {
                    this.node.position = this.curve.getPoint(ratio);
                    // 所有 note：按 α(t) 旋转飞行头（flick 箭头 / drag 拖尾 / tap 对称圆只是属性）
                    if (this.data.angle) {
                        this.node.angle = this.data.angle.at(ratio);
                    }
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
        if (this.endKeyNode) fadeKp(this.endKeyNode);
    }
}
