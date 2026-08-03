// 开始场景控制器：进入时淡入，点击开始按钮切到选曲场景。
// 节点约定：本节点或其名为 'start' / 'startBtn' 的子节点绑定 TOUCH_END。

import { _decorator, Component, Node, NodeEventType } from 'cc';
import { SceneTransition } from './SceneTransition';

const { ccclass } = _decorator;

@ccclass('StartScene')
export class StartScene extends Component {
    onLoad(): void {
        SceneTransition.fadeIn();
        const bind = (n: Node) => n.on(NodeEventType.TOUCH_END, () => SceneTransition.transitionTo('MusicSeries'), this);
        bind(this.node);
        const startBtn = this.node.getChildByName('startBtn') ?? this.node.getChildByName('start');
        if (startBtn) bind(startBtn);
    }
}
