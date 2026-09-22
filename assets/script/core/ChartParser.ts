// 谱面解析：把 resources/gameJson/MusicMap.json 里的原始数组规整为结构化对象。
// 顺手做旧字段兼容（部分条目用小写 opacity / startpointornot 等），
// 以及派生飞行时长(travel)/提前量(lead)，避免下游到处算。

import { RawNoteData, ChartData, NoteKind } from './types';
import { AngleData } from './AngleData';

export interface ParsedNote {
    ord: number;              // 在数组中的索引
    kind: NoteKind;           // tap / flick / drag
    keypoint: number[];       // 原始世界坐标（未缩放）
    starttime: number;        // ms
    endtime: number;          // ms（到达落点）
    touchornot: boolean;      // 是否可玩（需判定）
    startPointOrNot: boolean; // 显示起点关键点
    middlePointOrNot: boolean;// 显示中间关键点
    endPointOrNot: boolean;   // 显示落点关键点
    endpointname: string;     // 落点名
    opacity: number;          // 0~255
    travelMs: number;         // 飞行时长 = endtime - starttime（锁节拍，不可调）
    leadMs: number;           // 启动延迟 = endtime - travel
    angle?: AngleData;         // 所有 note：方向 α(t) 数据
}

export interface ParsedChart {
    notes: ParsedNote[];
    playableCount: number;    // touchornot=1 的 note 数（用于结算判定）
}

function asBool(v: unknown): boolean {
    return v === 1 || v === true || v === '1';
}
function asNumber(v: unknown, def: number): number {
    const n = typeof v === 'number' ? v : Number(v);
    return isNaN(n) ? def : n;
}

/** 把单个原始条目解析为 ParsedNote */
export function parseNote(raw: RawNoteData, ord: number): ParsedNote {
    const travel = Math.max(50, (raw.endtime - raw.starttime)); // 防止 0/负
    const lead = Math.max(0, raw.endtime - travel);
    return {
        ord,
        kind: (raw.Note as NoteKind) || 'tap',
        keypoint: raw.keypoint,
        starttime: raw.starttime,
        endtime: raw.endtime,
        touchornot: asBool(raw.touchornot),
        startPointOrNot: asBool(raw.startPointOrNot),
        middlePointOrNot: asBool(raw.middlePointOrNot),
        endPointOrNot: asBool(raw.endPointOrNot),
        endpointname: raw.endpointname,
        opacity: asNumber((raw as any).Opacity ?? (raw as any).opacity, 255),
        travelMs: travel,
        leadMs: lead,
        angle: new AngleData((raw as any).angle ?? (raw as any).alpha ?? 0),
    };
}

/** 解析整个谱面 */
export function parseChart(data: ChartData): ParsedChart {
    const rawList = data?.MusicMap ?? [];
    const notes = rawList.map((r, i) => parseNote(r, i));
    const playableCount = notes.filter(n => n.touchornot).length;
    return { notes, playableCount };
}
