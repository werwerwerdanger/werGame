// 统一场景过渡：替代旧工程里散落的 BlinkEffect / FadeInEffect / GOTO* / SceneEntryFade。
// 用一个全屏黑色覆盖层做淡入淡出，切场景时先淡出到黑再 loadScene，加载后淡入。
// 单例覆盖层挂在 Canvas 下，置于最顶层。

import { Node, director, UIOpacity, UITransform, Graphics, Color, tween, find, view } from 'cc';

export class SceneTransition {
    private static overlay: Node | null = null;

    /** 淡出到黑并切换场景 */
    static transitionTo(scene: string, fadeSec = 0.3): void {
        const o = SceneTransition.ensure();
        if (!o) { director.loadScene(scene); return; }
        const op = o.getComponent(UIOpacity)!;
        tween(op).stop();
        op.opacity = 0;
        tween(op).to(fadeSec, { opacity: 255 }).call(() => {
            director.loadScene(scene, () => SceneTransition.fadeIn(fadeSec));
        }).start();
    }

    /** 场景加载后淡入（从黑到透明） */
    static fadeIn(fadeSec = 0.3): void {
        const o = SceneTransition.ensure();
        if (!o) return;
        const op = o.getComponent(UIOpacity)!;
        op.opacity = 255;
        tween(op).to(fadeSec, { opacity: 0 }).start();
    }

    private static ensure(): Node | null {
        if (this.overlay && this.overlay.isValid) return this.overlay;
        const canvas = find('Canvas');
        if (!canvas) return null;
        const o = new Node('TransitionOverlay');
        o.setParent(canvas);
        o.setSiblingIndex(canvas.children.length);
        const sz = view.getVisibleSize();
        const ui = o.addComponent(UITransform);
        ui.setContentSize(sz.width, sz.height);
        const g = o.addComponent(Graphics);
        g.fillColor = new Color(0, 0, 0, 255);
        g.rect(-sz.width / 2, -sz.height / 2, sz.width, sz.height);
        g.fill();
        const op = o.addComponent(UIOpacity);
        op.opacity = 0;
        this.overlay = o;
        return o;
    }
}
