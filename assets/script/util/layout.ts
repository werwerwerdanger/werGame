// 动态布局适配：把"谱面世界坐标"（约 ±700 x, ±420 y）等比缩放到当前屏幕可见区，
// 保证落点 / 飞行轨迹在任意宽高比（16:9 / 20:9 / 4:3）下都不被裁切、不变形。
//
// 原理：FIXED_HEIGHT 模式下 view.getVisibleSize() 返回设计坐标系下的可见尺寸，
// 高度恒为设计高(720)，宽度随屏比变化。用 min(visW/BASE_W, visH/BASE_H) 取较小比例，
// 让内容整体落在可见区内（无裁切），且 x/y 同比例（无变形）。
//
// 判定完全不受影响：触控绑在缩放后的 EndNode 上，显示与判定用同一节点；
// 轨迹用同一个 scale 缩放，note 头落点 = EndNode 位置，三者重合。

import { view } from 'cc';

export const BASE_W = 1500; // 内容实际 x 范围约 ±700（1400），留余量
export const BASE_H = 900;  // 内容实际 y 范围约 ±420（840），留余量

let _scale = 1;

/** 进入游戏场景时调用一次（横屏锁定，进程内基本恒定）。返回计算出的 scale。 */
export function computeLayoutScale(): number {
    const vis = view.getVisibleSize();
    const sx = vis.width / BASE_W;
    const sy = vis.height / BASE_H;
    _scale = Math.min(sx, sy);
    return _scale;
}

/** 取当前 scale（Note / 落点定位时使用，未算过时回退 1 = 原行为） */
export function getLayoutScale(): number {
    return _scale;
}
