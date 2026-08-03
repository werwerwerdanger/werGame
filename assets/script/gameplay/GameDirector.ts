// 游戏主控制器：原 remorebettergame1.ts 上帝类的"拆分后主编排"。
// 只负责：加载设置/谱面/资源 → 起音乐 → 按 lead 调度每个 note → 接收触控/自动 Miss → 计分 → 结算。
// 具体逻辑下放给各子系统（NoteManager / EndNodeManager / JudgeSystem / ScoreSystem / AudioManager）。

import {
    _decorator, Component, Node, resources, JsonAsset, Label, UIOpacity, UITransform,
    Graphics, Color, Tween, AudioSource, NodeEventType, director, Widget, Sprite,
    ISchedulable,
} from 'cc';
import { loadSettings } from '../core/Settings';
import { ChartData, SettingsData } from '../core/types';
import { parseChart, ParsedChart, ParsedNote } from '../core/ChartParser';
import { ScoreSystem } from '../core/ScoreSystem';
import { JudgeResult, noteSizeScale } from '../core/types';
import { computeLayoutScale, getLayoutScale } from '../util/layout';
import { NoteManager } from './NoteManager';
import { EndNodeManager } from './EndNodeManager';
import { InputRouter } from './InputRouter';
import { NoteObject } from './NoteObject';
import { AudioManager } from '../audio/AudioManager';
import { HUD } from '../ui/HUD';

const { ccclass, property } = _decorator;

@ccclass('GameDirector')
export class GameDirector extends Component {
    /** 可选：落点/音符节点的父节点（不填则挂在游戏节点自身） */
    @property(Node) endNodeParent: Node | null = null;

    private settings!: SettingsData;
    private chart!: ParsedChart;
    private score = new ScoreSystem();
    private noteMgr!: NoteManager;
    private endMgr!: EndNodeManager;
    private input = new InputRouter();
    private audio!: AudioManager;
    private bgmSource: AudioSource | null = null;

    private gameStartTime = 0;
    private paused = false;
    private pauseStartedAt = 0;
    private ended = false;
    private notesFinished = 0;
    private playableTotal = 0;
    private scoreLabel: Label | null = null;
    private hud!: HUD;

    onLoad(): void {
        this.settings = loadSettings();
        const parent = this.endNodeParent ?? this.node;
        this.noteMgr = new NoteManager(parent);
        this.endMgr = new EndNodeManager(parent);
        this.audio = new AudioManager(this.node);
        this.score.reset();
        this.ended = false;
        this.paused = false;
        this.notesFinished = 0;
        this.scoreLabel = this.node.getChildByName('scroe')?.getComponent(Label) ?? null;
        this.hud = new HUD(this.node);
    }

    async start(): Promise<void> {
        computeLayoutScale();
        this.setupBackground();

        this.bgmSource = this.node.getComponent(AudioSource);
        this.audio.attachBgmSource(this.bgmSource);
        this.audio.setMusicVol(this.settings.musicVol);
        this.audio.setSfxVol(this.settings.sfxVol);

        // 预加载精灵 + 音频（资源缺失不阻断游戏）
        await Promise.all([
            this.noteMgr.preload(),
            this.audio.loadClips(),
            this.audio.loadSfx('sfx/hit'),
        ]);

        const chartData = await this.loadChart();
        this.chart = parseChart(chartData);
        this.playableTotal = this.chart.playableCount;

        this.gameStartTime = Date.now();
        this.audio.playBgm();

        for (const p of this.chart.notes) {
            this.scheduleNote(p);
        }

        const pauseBtn = this.node.getChildByName('pause');
        if (pauseBtn) pauseBtn.on(NodeEventType.TOUCH_END, this.togglePause, this);

        if (this.settings.playMode === 'key') {
            this.input.onTouch((ep) => this.onEndpointTouch(ep));
            this.input.buildDefaultMap();
            this.input.enable();
        }
    }

    private loadChart(): Promise<ChartData> {
        return new Promise((resolve, reject) => {
            resources.load('gameJson/MusicMap', JsonAsset, (err, json) => {
                if (err || !json) { reject(err); return; }
                resolve(json.json as ChartData);
            });
        });
    }

    /** 按谱面 lead 延迟后，创建落点 + 音符，并注册判定 */
    private scheduleNote(p: ParsedNote): void {
        const travelSec = Math.max(0.05, p.travelMs / 1000);
        const leadSec = Math.max(0, p.leadMs / 1000);
        this.scheduleOnce(() => {
            if (this.ended) return;

            const endNode = this.endMgr.createOrGet(p.endpointname);
            const scale = getLayoutScale();
            const skp = p.keypoint.map(v => v * scale);
            const last = skp.length - 2;
            endNode.position.set(skp[last], skp[last + 1], 0);
            if (p.endPointOrNot) this.endMgr.fadeInEnd(p.endpointname, p.opacity / 255);

            if (p.touchornot) {
                this.endMgr.bindTouch(p.endpointname, (ep) => this.onEndpointTouch(ep));
            }

            const note = this.noteMgr.spawn(p, endNode, this.settings.trackOn, noteSizeScale(this.settings.noteSize));
            if (p.touchornot) this.endMgr.register(p, note);

            note.startMove(travelSec, () => this.onNoteArrive(p.endpointname, p.ord));
        }, leadSec);
    }

    /** 落点触控 → 解析命中 */
    private onEndpointTouch(ep: string): void {
        if (this.ended || this.paused) return;
        const elapsed = Date.now() - this.gameStartTime + this.settings.judgeOffset;
        const out = this.endMgr.handleTouch(ep, elapsed);
        if (!out) return;
        this.applyJudge(out.record.result, out.note);
    }

    /** 音符到达落点未命中 → 自动 Miss */
    private onNoteArrive(ep: string, ord: number): void {
        if (this.ended) return;
        const elapsed = Date.now() - this.gameStartTime + this.settings.judgeOffset;
        const note = this.endMgr.autoMiss(ep, ord, elapsed);
        if (!note) return;
        this.applyJudge(JudgeResult.Miss, note);
    }

    private applyJudge(result: JudgeResult, note: NoteObject): void {
        const { combo } = this.score.apply(result);
        if (this.scoreLabel) this.scoreLabel.string = this.score.getScoreString();
        this.hud.setCombo(combo);
        this.hud.flashJudge(result);
        if (result !== JudgeResult.Miss) this.audio.playHit();
        this.noteMgr.recycleNote(note, 0.08);
        this.notesFinished++;
        this.checkEnd();
    }

    private togglePause(): void {
        if (this.ended) return;
        if (!this.paused) {
            this.paused = true;
            this.pauseStartedAt = Date.now();
            this.noteMgr.pauseAll();                       // 冻结所有音符 Tween
            director.getScheduler().pauseTarget(this as unknown as ISchedulable); // 冻结本脚本的 scheduleOnce（谱面调度）
            this.audio.pauseBgm();
        } else {
            const dt = Date.now() - this.pauseStartedAt;
            this.gameStartTime += dt; // 偏移起点，保证 resume 后时序连续
            this.paused = false;
            this.noteMgr.resumeAll();
            director.getScheduler().resumeTarget(this as unknown as ISchedulable);
            this.audio.resumeBgm();
        }
    }

    private checkEnd(): void {
        if (this.ended) return;
        if (this.playableTotal > 0 && this.notesFinished >= this.playableTotal) {
            this.ended = true;
            this.scheduleOnce(() => this.showResult(), 0.6);
        }
    }

    private showResult(): void {
        const canvas = this.node.parent ?? this.node;
        const panel = new Node('ResultPanel');
        panel.setParent(canvas);
        panel.addComponent(UITransform)?.setContentSize(600, 400);
        const bg = new Node('ResultBg');
        bg.setParent(panel);
        const bgSprite = bg.addComponent(Graphics);
        bgSprite.fillColor = new Color(0, 0, 0, 200);
        bgSprite.rect(-300, -200, 600, 400);
        bgSprite.fill();
        bg.addComponent(UITransform)?.setContentSize(600, 400);

        const label = new Node('ResultText');
        label.setParent(panel);
        const lc = label.addComponent(Label);
        const acc = this.score.getAccuracy().toFixed(1);
        lc.string =
            `游戏结束\n分数: ${this.score.getScoreString()}\n` +
            `Perfect: ${this.score.getPerfect()}  Great: ${this.score.getGreat()}  Miss: ${this.score.getMiss()}\n` +
            `最大连击: ${this.score.getMaxCombo()}\n准确率: ${acc}%`;
        lc.fontSize = 32;
        lc.lineHeight = 40;
        lc.color = new Color(255, 255, 255, 255);
        label.addComponent(UITransform)?.setContentSize(500, 280);
        panel.position.set(0, 0, 100);
    }

    private setupBackground(): void {
        const parent = this.node.parent;
        if (!parent) return;
        const bg = parent.getChildByName('background');
        if (bg) {
            const w = bg.getComponent(Widget);
            if (w) bg.removeComponent(w);
            const ui = bg.getComponent(UITransform);
            if (ui) ui.setContentSize(1280, 720);
            const sp = bg.getComponent(Sprite);
            if (sp) sp.sizeMode = Sprite.SizeMode.CUSTOM;
            const op = bg.getComponent(UIOpacity);
            if (op) op.opacity = this.settings.bgDim;
        }
        if (!parent.getChildByName('bgColorFill')) {
            const fill = new Node('bgColorFill');
            fill.parent = parent;
            fill.setSiblingIndex(0);
            const fui = fill.addComponent(UITransform);
            fui.setContentSize(8192, 8192);
            const g = fill.addComponent(Graphics);
            const base = new Color(15, 18, 28);
            const k = this.settings.bgDim / 255;
            g.fillColor = new Color(base.r * k, base.g * k, base.b * k, 255);
            g.rect(-4096, -4096, 8192, 8192);
            g.fill();
        }
    }
}
