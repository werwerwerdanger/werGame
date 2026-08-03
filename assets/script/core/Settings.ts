// 设置读写：统一封装 sys.localStorage，键名与旧端(SettingNew.ts)完全一致。
// 裸 localStorage 在原生打包会失效，必须用 cc 的 sys.localStorage。
// H5 隐私模式下访问会抛异常，包 try-catch 兜底回退默认，保证游戏不崩。

import { sys } from 'cc';
import { SettingsData } from './types';

const K = {
    judgeOffset: 'judgeOffset',
    noteSize: 'noteSize',
    bgDim: 'bgDim',
    trackOn: 'trackOn',
    musicVol: 'musicVol',
    sfxVol: 'sfxVol',
    fxOn: 'fxOn',
    playMode: 'playMode',
} as const;

function lsGet(key: string): string | null {
    try { return sys.localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key: string, val: string): void {
    try { sys.localStorage.setItem(key, val); } catch (e) { /* 静默忽略 */ }
}
function getNum(key: string, def: number): number {
    const raw = lsGet(key);
    const v = raw === null ? def : Number(raw);
    return isNaN(v) ? def : v;
}
function getStr(key: string, def: string): string {
    const raw = lsGet(key);
    return raw === null ? def : raw;
}

/** 从持久化存储载入设置（每次进入游戏场景都应调用，使"改设置→返回游戏"立即生效） */
export function loadSettings(): SettingsData {
    const noteSize = getStr(K.noteSize, 'normal');
    const playMode = getStr(K.playMode, 'touch');
    return {
        judgeOffset: getNum(K.judgeOffset, 0),
        noteSize: noteSize === 'small' || noteSize === 'large' ? noteSize : 'normal',
        bgDim: getNum(K.bgDim, 100),
        trackOn: getStr(K.trackOn, 'on') === 'on',
        musicVol: getNum(K.musicVol, 80),
        sfxVol: getNum(K.sfxVol, 80),
        fxOn: getStr(K.fxOn, 'on') === 'on',
        playMode: playMode === 'key' ? 'key' : 'touch',
    };
}

/** 写回设置 */
export function saveSettings(s: SettingsData): void {
    lsSet(K.judgeOffset, String(s.judgeOffset));
    lsSet(K.noteSize, s.noteSize);
    lsSet(K.bgDim, String(s.bgDim));
    lsSet(K.trackOn, s.trackOn ? 'on' : 'off');
    lsSet(K.musicVol, String(s.musicVol));
    lsSet(K.sfxVol, String(s.sfxVol));
    lsSet(K.fxOn, s.fxOn ? 'on' : 'off');
    lsSet(K.playMode, s.playMode);
}
