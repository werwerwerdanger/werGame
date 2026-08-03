// 游戏内 HUD：连击数 + 判定文字闪现。GameDirector 持有其实例并在每次判定时调用。
// 节点约定：游戏节点下名为 'combo'（显示连击）与 'judge'（显示 Perfect/Great/Miss）的子节点。

import { Node, Label, Color, tween, UIOpacity } from 'cc';
import { JudgeResult } from '../core/types';

export class HUD {
    private comboLabel: Label | null = null;
    private judgeNode: Node | null = null;
    private judgeLabel: Label | null = null;

    constructor(root: Node) {
        this.comboLabel = root.getChildByName('combo')?.getComponent(Label) ?? null;
        this.judgeNode = root.getChildByName('judge');
        this.judgeLabel = this.judgeNode?.getComponent(Label) ?? null;
    }

    setCombo(c: number): void {
        if (this.comboLabel) this.comboLabel.string = c > 1 ? `${c} COMBO` : '';
    }

    flashJudge(result: JudgeResult): void {
        if (!this.judgeLabel || !this.judgeNode) return;
        this.judgeLabel.string = result;
        const colorMap: Record<JudgeResult, Color> = {
            [JudgeResult.Perfect]: new Color(255, 215, 0),
            [JudgeResult.Great]: new Color(0, 200, 255),
            [JudgeResult.Miss]: new Color(255, 80, 80),
        };
        this.judgeLabel.color = colorMap[result] ?? new Color(255, 255, 255);
        const op = this.judgeNode.getComponent(UIOpacity) ?? this.judgeNode.addComponent(UIOpacity);
        op.opacity = 255;
        tween(op).to(0.4, { opacity: 0 }).start();
    }
}
