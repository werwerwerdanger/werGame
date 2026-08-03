// 判定系统（纯逻辑，不依赖 cc 组件）：给定当前节拍与某落点待判定列表，解析命中结果。
// 判定窗口：≤50ms Perfect / ≤100ms Great / 否则（超出窗口的点 touch 不在此处理，由 autoMiss 兜底 Miss）。

import { JudgeResult, JudgeRecord } from './types';

export const PERFECT_WINDOW = 50;  // ms
export const GREAT_WINDOW = 100;   // ms

export interface PendingNote {
    ord: number;
    endtime: number;   // ms（相对音乐起点）
    hit: boolean;
    // 回调用的上下文，具体类型由 gameplay 层提供
    ctx: any;
}

export interface JudgeOutcome {
    record: JudgeRecord;
    pending: PendingNote; // 被命中的那条（已置 hit=true）
}

/**
 * 处理一次对某落点的触控。
 * @param elapsedMs 当前相对音乐起点的时间(ms)，已叠加 judgeOffset 修正
 * @param pending   该落点当前未结算（含未命中）的 note 列表（会被原地修改 hit 标记）
 * @returns 命中的结果；若无可判定 note 或全已命中，返回 null
 */
export function resolveTouch(elapsedMs: number, pending: PendingNote[]): JudgeOutcome | null {
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < pending.length; i++) {
        if (pending[i].hit) continue;
        const diff = Math.abs(elapsedMs - pending[i].endtime);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
        }
    }
    if (bestIdx === -1) return null;
    const entry = pending[bestIdx];
    entry.hit = true;
    let result: JudgeResult;
    if (bestDiff <= PERFECT_WINDOW) result = JudgeResult.Perfect;
    else if (bestDiff <= GREAT_WINDOW) result = JudgeResult.Great;
    else result = JudgeResult.Great; // 触控命中即至少 Great（超出窗口的 Miss 由 autoMiss 触发）
    return {
        record: { ord: entry.ord, result, diffMs: bestDiff },
        pending: entry,
    };
}

/**
 * 自动 Miss 检测：note 到达落点且超过 Great 窗口仍未命中时调用。
 * @returns 该 note 是否确实 Miss（未命中返回 true；已命中返回 false）
 */
export function isAutoMiss(elapsedMs: number, pending: PendingNote): boolean {
    if (pending.hit) return false;
    return Math.abs(elapsedMs - pending.endtime) > GREAT_WINDOW;
}
