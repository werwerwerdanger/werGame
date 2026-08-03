// 全局类型定义：谱面 / 判定 / 设置。被 core 与 gameplay 各模块共享。

/** 音符种类（与 resources/NoteImage 下目录名、谱面 Note 字段一致，全小写） */
export type NoteKind = 'tap' | 'flick' | 'drag';

/** 谱面原始条目（MusicMap.json 中 MusicMap 数组的元素）。
 *  字段名与旧工程保持一致，便于直接喂给 ChartParser，不破坏现有谱面文件。 */
export interface RawNoteData {
    Note: string;                 // 'tap' | 'flick' | 'drag'
    keypoint: number[];           // 扁平世界坐标 [x0,y0, x1,y1, ...]，首点为起点、末点为落点
    starttime: number;            // 出发时刻(ms，相对音乐起点)
    endtime: number;              // 到达落点时刻(ms，锁音乐节拍)
    measureID?: number;
    Opacity?: number;             // 0~255，部分条目用小写 opacity
    touchornot: number;           // 1 = 可玩(需判定)，0 = 仅展示轨迹
    startPointOrNot?: number;     // 是否显示起点关键点
    middlePointOrNot?: number;    // 是否显示中间关键点
    endpointname: string;         // 落点名(EndNode0..32)，per-note 绑定
    endPointOrNot?: number;       // 是否显示落点关键点
    segmentID?: number;
    note_count?: number;
}

/** 解析后的谱面对象 */
export interface ChartData {
    MusicMap: RawNoteData[];
}

/** 判定结果 */
export enum JudgeResult {
    Perfect = 'Perfect',
    Great = 'Great',
    Miss = 'Miss',
}

/** 单条判定记录（供 HUD / 结算使用） */
export interface JudgeRecord {
    ord: number;
    result: JudgeResult;
    diffMs: number;
}

/** 运行期设置（与 sys.localStorage 键一一对应） */
export interface SettingsData {
    judgeOffset: number;                          // 判定偏移(ms)，补偿触控延迟
    noteSize: 'small' | 'normal' | 'large';
    bgDim: number;                                // 背景亮度 0~100
    trackOn: boolean;                             // 轨道(关键点)显示
    musicVol: number;                             // 音乐音量 0~100
    sfxVol: number;                               // 音效音量 0~100
    fxOn: boolean;                                // 特效开关
    playMode: 'touch' | 'key';                    // 游玩方式
}

/** 音符显示尺寸系数 */
export function noteSizeScale(s: SettingsData['noteSize']): number {
    return s === 'small' ? 0.7 : s === 'large' ? 1.4 : 1.0;
}
