// 输入路由（键盘模式，touch 模式不启用）：把物理按键映射到落点名，触发与触摸相同的判定回调。
// 落点有 EndNode0..32 共 33 个，键盘无法一一对应，这里仅把数字键 1~9、0 映射到 EndNode1~EndNode10，
// 作为 key 模式的最小可用实现；如需完整映射在 Settings 里扩展 keymap 即可。
// touch 模式由 EndNodeManager 直接绑 TOUCH_END，不经过这里。

import { input, Input, KeyCode, EventKeyboard } from 'cc';

export class InputRouter {
    private map = new Map<KeyCode, string>();
    private cb: (ep: string) => void = () => {};
    private enabled = false;

    private handler = (e: EventKeyboard) => {
        const ep = this.map.get(e.keyCode);
        if (ep) this.cb(ep);
    };

    /** 设置触控回调 */
    onTouch(cb: (ep: string) => void): void { this.cb = cb; }

    /** 用默认数字键映射初始化（EndNode1..EndNode10） */
    buildDefaultMap(): void {
        const digits: [KeyCode, number][] = [
            [KeyCode.DIGIT_1, 1], [KeyCode.DIGIT_2, 2], [KeyCode.DIGIT_3, 3], [KeyCode.DIGIT_4, 4],
            [KeyCode.DIGIT_5, 5], [KeyCode.DIGIT_6, 6], [KeyCode.DIGIT_7, 7], [KeyCode.DIGIT_8, 8],
            [KeyCode.DIGIT_9, 9], [KeyCode.DIGIT_0, 10],
        ];
        digits.forEach(([code, idx]) => this.map.set(code, 'EndNode' + idx));
    }

    enable(): void {
        if (this.enabled) return;
        input.on(Input.EventType.KEY_DOWN, this.handler, this);
        this.enabled = true;
    }

    disable(): void {
        if (!this.enabled) return;
        input.off(Input.EventType.KEY_DOWN, this.handler, this);
        this.enabled = false;
    }
}
