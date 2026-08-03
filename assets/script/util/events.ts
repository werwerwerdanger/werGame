// 轻量事件名常量（避免散落字符串魔法值），后续如需事件总线可挂在这里。
// 当前 GameDirector 直接持有各子系统引用，未强依赖事件总线；
// 预留常量以便 HUD / 结算面板订阅判定事件。

export const GameEvent = {
    JUDGE: 'judge',          // 单次判定结果 (JudgeRecord)
    SCORE: 'score',          // 分数变化 (number)
    COMBO: 'combo',          // 连击变化 (number)
    GAME_END: 'gameEnd',     // 游戏结束
} as const;

export type GameEventName = typeof GameEvent[keyof typeof GameEvent];
