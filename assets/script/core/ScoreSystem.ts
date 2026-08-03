// 计分系统（纯逻辑）：连击 / 分数 / 精度统计。每次判定结果喂进来，维护累计状态。

import { JudgeResult } from './types';

const SCORE_TABLE: Record<JudgeResult, number> = {
    [JudgeResult.Perfect]: 1000,
    [JudgeResult.Great]: 700,
    [JudgeResult.Miss]: 0,
};

// 精度权重：Perfect 满权、Great 0.7、Miss 0
const ACC_WEIGHT: Record<JudgeResult, number> = {
    [JudgeResult.Perfect]: 1,
    [JudgeResult.Great]: 0.7,
    [JudgeResult.Miss]: 0,
};

export class ScoreSystem {
    private score = 0;
    private combo = 0;
    private maxCombo = 0;
    private perfect = 0;
    private great = 0;
    private miss = 0;
    private totalJudged = 0;

    /** 喂入一次判定结果，返回本次加分与当前连击（供 HUD 刷新） */
    apply(result: JudgeResult): { gained: number; combo: number } {
        if (result === JudgeResult.Miss) {
            this.miss++;
            this.combo = 0;
        } else {
            this.combo++;
            if (this.combo > this.maxCombo) this.maxCombo = this.combo;
            if (result === JudgeResult.Perfect) this.perfect++;
            else this.great++;
        }
        this.totalJudged++;
        this.score += SCORE_TABLE[result];
        return { gained: SCORE_TABLE[result], combo: this.combo };
    }

    getScore(): number { return this.score; }
    getCombo(): number { return this.combo; }
    getMaxCombo(): number { return this.maxCombo; }
    getPerfect(): number { return this.perfect; }
    getGreat(): number { return this.great; }
    getMiss(): number { return this.miss; }

    /** 准确率(0~100)，无判定时返回 0 */
    getAccuracy(): number {
        if (this.totalJudged === 0) return 0;
        let w = 0;
        w += this.perfect * ACC_WEIGHT[JudgeResult.Perfect];
        w += this.great * ACC_WEIGHT[JudgeResult.Great];
        w += this.miss * ACC_WEIGHT[JudgeResult.Miss];
        return (w / this.totalJudged) * 100;
    }

    /** 8 位补零分数串（兼容旧 "scroe" Label 显示） */
    getScoreString(): string {
        return ('00000000' + Math.round(this.score)).slice(-8);
    }

    reset(): void {
        this.score = 0; this.combo = 0; this.maxCombo = 0;
        this.perfect = 0; this.great = 0; this.miss = 0; this.totalJudged = 0;
    }
}
