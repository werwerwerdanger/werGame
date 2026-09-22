// 角度数据（通用）：把谱面 JSON 里描述的 α(t)（方向角关于归一化飞行进度 t∈[0,1] 的函数）
// 封装成一个类，提供 at(t) 求值和 endAngle（到达落点时的方向）。
// α 单位是度，约定 0° = +x（右），在谱面世界坐标里 CCW 为正（与 Cocos Node.angle 一致）。
// 插值用拉格朗日多项式穿过给定采样点（只提供几个 α(t_n) 即可），比逐段线性更平滑。

/** α(t) 的 JSON 表达（都认，内部统一规整）：
 *  - number：常数方向（整个飞行过程方向不变）——最简洁，推荐大多数 note 用
 *  - number[]：扁平采样点 [t0,a0, t1,a1, ...]，t∈[0,1] 为归一化飞行进度，a 为方向角(度)
 *             比对象数组更省篇幅，扫动 note 推荐用这个
 *  - {t,a}[]：对象采样点（同上，兼容老写法）
 *  运行时全部走拉格朗日插值 */
export type AlphaExpr = number | number[] | { t: number; a: number }[];

function toKeyframes(alpha: AlphaExpr): { t: number; a: number }[] {
    if (typeof alpha === 'number') {
        return [{ t: 0, a: alpha }, { t: 1, a: alpha }];
    }
    if (alpha.length === 0) {
        return [{ t: 0, a: 0 }, { t: 1, a: 0 }];
    }
    // 扁平数组 [t0,a0, t1,a1, ...]：首元素是 number
    if (typeof alpha[0] === 'number') {
        const flat = alpha as number[];
        if (flat.length % 2 !== 0) {
            throw new Error('AngleData: 扁平数组必须是 [t,a,...] 偶数长度');
        }
        const out: { t: number; a: number }[] = [];
        for (let i = 0; i < flat.length; i += 2) out.push({ t: flat[i], a: flat[i + 1] });
        return out;
    }
    return alpha as { t: number; a: number }[];
}

export class AngleData {
    /** 升序去重采样点（常数会展开成两端点） */
    private keys: { t: number; a: number }[];
    private tmin: number;
    private tmax: number;

    constructor(alpha: AlphaExpr) {
        const raw = toKeyframes(alpha);
        // 同 t 取最后一个，按 t 升序，保证拉格朗日基分母非 0
        const map = new Map<number, number>();
        for (const p of raw) map.set(p.t, p.a);
        this.keys = [...map.entries()].map(([t, a]) => ({ t, a })).sort((p, q) => p.t - q.t);
        this.tmin = this.keys[0].t;
        this.tmax = this.keys[this.keys.length - 1].t;
    }

    /** α(t)，t∈[0,1]，拉格朗日插值；越界 clamp 到端点采样（避免外推数值爆炸） */
    at(t: number): number {
        const k = this.keys;
        if (k.length === 1) return k[0].a;
        if (t < this.tmin) t = this.tmin;
        if (t > this.tmax) t = this.tmax;
        let sum = 0;
        for (let i = 0; i < k.length; i++) {
            let term = k[i].a;
            for (let j = 0; j < k.length; j++) {
                if (j === i) continue;
                term *= (t - k[j].t) / (k[i].t - k[j].t);
            }
            sum += term;
        }
        return sum;
    }

    /** 到达落点那一刻的方向角（用于收尾/校验） */
    get endAngle(): number {
        return this.at(1);
    }
}
