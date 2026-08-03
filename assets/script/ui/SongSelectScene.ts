// 选曲场景控制器：进入时淡入；名为 'song*' 的子节点点击进入游戏场景；
// 名为 'back' 的子节点点击返回开始场景。
// 具体歌曲/谱面选择逻辑可在此扩展（目前单谱面，统一进 IN_game）。

import { _decorator, Component, Node, NodeEventType } from 'cc';
import { SceneTransition } from './SceneTransition';

const { ccclass } = _decorator;

@ccclass('SongSelectScene')
export class SongSelectScene extends Component {
    onLoad(): void {
        SceneTransition.fadeIn();
        this.node.children.forEach(ch => {
            if (ch.name.startsWith('song') || ch.name.startsWith('Song')) {
                ch.on(NodeEventType.TOUCH_END, () => SceneTransition.transitionTo('IN_game'), this);
            }
        });
        const back = this.node.getChildByName('back');
        if (back) back.on(NodeEventType.TOUCH_END, () => SceneTransition.transitionTo('start'), this);
    }
}
