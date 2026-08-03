// 通用贝塞尔曲线（移植自旧 prework/BezierCurve.ts，逻辑不变，仅改名与导出方式调整）。
// 控制点以扁平数组传入：[x0, y0, x1, y1, ...]。
// getPoint(t) 返回 t∈[0,1] 时曲线上的坐标（z 恒为 0）。
// 阶数 = 控制点数量 - 1，例如 3 个控制点即二次贝塞尔。

import { Vec3 } from 'cc';

/** 组合数 C(i, n) = n! / (i! * (n-i)!)，用交叉乘除避免溢出 */
function C(i: number, n: number): number {
    if (i < 0 || i > n) return 0;
    let res = 1;
    for (let k = 0; k < i; k++) {
        res = (res * (n - k)) / (1 + k);
    }
    return res;
}

export class Bezier {
    private points: Vec3[] = [];

    constructor(flatPoints: number[]) {
        for (let i = 0; i < flatPoints.length; i += 2) {
            this.points.push(new Vec3(flatPoints[i], flatPoints[i + 1], 0));
        }
    }

    get pointCount(): number {
        return this.points.length;
    }

    /** t 自动 clamp 到 [0,1]，返回曲线坐标 */
    getPoint(t: number): Vec3 {
        const n = this.points.length - 1;
        if (n < 0) return new Vec3(0, 0, 0);
        const ct = Math.max(0, Math.min(1, t));
        let x = 0;
        let y = 0;
        for (let i = 0; i <= n; i++) {
            const coeff = C(i, n);
            const term = coeff * Math.pow(ct, i) * Math.pow(1 - ct, n - i);
            x += term * this.points[i].x;
            y += term * this.points[i].y;
        }
        return new Vec3(x, y, 0);
    }
}
