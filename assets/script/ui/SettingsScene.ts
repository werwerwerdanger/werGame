import { _decorator, Component, Node, Slider, Label, Button, ScrollView, director, resources, JsonAsset, SpriteFrame, Sprite, Vec3, tween, EventTouch, UITransform, UIOpacity, Color, BlockInputEvents, assetManager, AudioSource, AudioClip, input, KeyCode, EventKeyboard } from 'cc';
import { loadSettings, saveSettings } from '../core/Settings';
import { SettingsData, ChartData, JudgeResult } from '../core/types';
import { parseChart, ParsedChart, ParsedNote } from '../core/ChartParser';
import { NoteManager } from '../gameplay/NoteManager';
import { EndNodeManager } from '../gameplay/EndNodeManager';
import { NoteObject } from '../gameplay/NoteObject';
import { getLayoutScale } from '../util/layout';
const { ccclass, property } = _decorator;

// 弹窗用的 UI 贴图（assets/textures/ui 下，不在 resources，用 uuid 直接加载）
const UI_BG_SF = '4937ed1e-6b18-4fcf-8d18-c6361a7dcfcc@f9941';   // ui_bg (1216x832)
const UI_ROUND_SF = '2e2443e6-1068-472d-bb44-15cf6cb7e45a@f9941'; // ui_round (64x64)

@ccclass('SettingsScene')
export class SettingsScene extends Component {
  private settings: SettingsData = loadSettings();

  // 右侧预览：复用游戏内同一套 NoteManager/EndNodeManager 驱动一个 TAP 流，落点可触摸判定（含 judgeOffset）
  private previewChart: ParsedChart | null = null;
  private previewParent: Node | null = null;
  private previewNoteMgr: NoteManager | null = null;
  private previewEndMgr: EndNodeManager | null = null;
  private previewGameStartTime = 0;        // 音乐起点(ms)，音频实际 play 时记录；仅作音频不可用时的回退基准
  private previewNextBeat = 0;             // 下一个尚未 spawn 的 note 序号（固定节拍网格，offset 只作为该 note 的出现阈值）
  private previewSpawnEveryBeats = 1;       // 出 note 的间隔(拍)：每 1 拍出一个(≈0.5s@120BPM)，与 travelMs 等长，保证同一时刻只有一个 note 在飞（单 note 循环），不会形成多 note 流
  private previewJudgeLabel: Label | null = null;
  private previewStreamScheduled = false;
  private previewAudioSource: AudioSource | null = null;
  private previewAudioClipDuration = 4;    // drumLoop8 长度(s)，用于 currentTime 循环回绕检测
  private previewAudioTimeAccum = 0;       // 累计音频时间(s)，处理 loop 回绕后保持单调
  private previewLastCurrentTime = 0;      // 上一帧 currentTime，用于检测回绕

  // 预览共享几何：仅创建“一套”keynote/startnode/endnode（起点顶、终点底），所有 note 共用，位置写死在 json keypoint。
  // 每个 note 从对象池独立拉出 -> 运动(各自 tween) -> 抵达终点(各自 onArrive) -> 回池(各自 recycle)，互不耦合。
  private previewKpFrame: SpriteFrame | null = null;                 // 关键点贴图(起点/终点统一灰环)
  private previewStartMarker: Node | null = null;                    // 共享起点标记(顶，常驻、固定)
  private previewEndMarker: Node | null = null;                      // 共享终点标记(底，常驻、固定) = 所有 note 的飞行目标
  private previewPathBase: { sx: number; sy: number; ex: number; ey: number } | null = null; // 缩放后的路径端点
  private previewTravelMs = 1500;
  private previewActiveEndNode: Node | null = null;                  // 共享终点(飞行目标/判定文字锚点)

  // 预览判定（自包含，不依赖 EndNodeManager 的 register/autoMiss）：每个活跃 note 记出生时刻(spawnElapsed)，
  // 位置由 updatePreviewSpawn 每帧根据当前 judgeOffset 实时重算；触摸任意演示区都算一次判定（不回收，到终点才结算）。
  private previewPending: { note: NoteObject; spawnElapsed: number; tapped: boolean }[] = [];
  private previewSpawnCount = 0;

  // 判定偏移自动校准（独立按钮 -> 模态弹窗）
  private calibMask: Node | null = null; // 全屏遮罩（含弹窗），active 控制开关
  private calibNote: Node | null = null; // 弹窗里左右移动的 note
  private calibHint: Label | null = null; // 弹窗顶部提示文字
  private noteLeft = -360;
  private noteRight = 360;
  private noteSpeed = 280; // px/s
  private samples: number[] = [];
  private calibDone = false; // 采满 5 次后置 true，避免重复写入
  private panelW = 1000;
  private panelH = 640;

  onLoad() {
    const panel = this.node; // Canvas
    this.settings = loadSettings();

    // sliders
    // judgeOffset 物理意义为毫秒(ms)：中间 0，左右各 ±500ms（线性：v = min + progress*(max-min)）
    this.wireSlider(panel, 'judgeOffset', -500, 500, 5, 0, 'ms');
    this.wireSlider(panel, 'bgDim', 0, 100, 5, 100);
    this.wireSlider(panel, 'musicVol', 0, 100, 5, 80);
    this.wireSlider(panel, 'sfxVol', 0, 100, 5, 80);

    // toggles
    this.wireToggle(panel, 'fxOn', ['关', '开'], 1);
    this.wireToggle(panel, 'trackOn', ['关', '开'], 1);

    // 材质替换按钮（占位，具体切换逻辑见 onMatSwapTap）
    this.wireButton(panel, 'matSwap');

    // 动态插入“判定偏移校准”按钮 + 创建校准弹窗（必须在 setupScroll 之前，好让滚动区间算上按钮）
    this.buildCalibButton(panel);
    this.buildCalibPopup(panel);

    this.setupScroll(panel);
    this.initPreview();

    const back = panel.getChildByName('返回');
    if (back) back.on(Button.EventType.CLICK, () => director.loadScene('start'));
  }

  private findByName(root: Node, name: string): Node | null {
    let found: Node | null = null;
    const walk = (n: Node) => {
      if (found) return;
      if (n.name === name) { found = n; return; }
      for (const c of n.children) walk(c);
    };
    for (const c of root.children) walk(c);
    return found;
  }

  private wireSlider(panel: Node, key: string, min: number, max: number, step: number, def: number, unit: string = '', onChange?: () => void) {
    const sliderNode = this.findByName(panel, key + '_slider');
    const valNode = this.findByName(panel, key + '_val');
    if (!sliderNode) return;
    const slider = sliderNode.getComponent(Slider);
    const valLabel = valNode ? valNode.getComponent(Label) : null;

    // 关键修复：拖动滑块时阻止触摸事件冒泡到列表滚动节点 settingsScroll。
    // 否则手指轻微竖直位移会让整个左侧列表跟着上下滑，滑块被移出手指下方、
    // slide 回调不再触发。设置 propagationStopped 只阻断向祖先冒泡，不影响滑块自身监听。
    const blockScroll = (e: EventTouch) => { e.propagationStopped = true; };
    sliderNode.on(Node.EventType.TOUCH_START, blockScroll);
    sliderNode.on(Node.EventType.TOUCH_MOVE, blockScroll);

    const cur = this.settings[key as keyof SettingsData] as number;
    if (slider) {
      const span = max - min;
      slider.progress = span > 0 ? (cur - min) / span : 0;
      // 滑块只管自己的 'slide' 事件（基于 handle 的 x 位置）；
      // 竖直拖动时面板滚动、滑块值不变，二者由 setupScroll 手动协调。
      slider.node.on('slide', (s: Slider) => {
        let v = min + s.progress * span;
        v = Math.round(v / step) * step;
        v = Math.max(min, Math.min(max, v));
        (this.settings as any)[key] = v;
        if (valLabel) valLabel.string = String(v) + unit;
        saveSettings(this.settings);
        onChange?.();
      });
    }
    if (valLabel) valLabel.string = String(cur) + unit;
  }

  private wireToggle(panel: Node, key: string, vals: string[], def: number) {
    const btnNode = this.findByName(panel, key + '_btn');
    if (!btnNode) return;
    const dispNode = this.findByName(panel, key + '_disp');
    const dispLabel = dispNode ? dispNode.getComponent(Label) : null;

    let idx = (this.settings[key as keyof SettingsData] as boolean) ? 1 : 0;
    if (idx < 0 || idx >= vals.length) idx = def;

    const refresh = () => {
      if (dispLabel) dispLabel.string = vals[idx];
    };
    refresh();

    btnNode.on(Button.EventType.CLICK, () => {
      idx = (idx + 1) % vals.length;
      (this.settings as any)[key] = idx === 1;
      refresh();
      saveSettings(this.settings);
    });
  }

  private wireButton(panel: Node, key: string) {
    const btnNode = this.findByName(panel, key + '_btn');
    if (!btnNode) return;
    btnNode.on(Button.EventType.CLICK, () => this.onMatSwapTap());
  }

  // 材质替换（占位）：点按钮时切换 note / 判定点贴图包。
  // 后续实现示例：从 resources 加载不同材质包，遍历 NoteManager 的 sprite 替换 spriteFrame。
  private onMatSwapTap() {
    // TODO: 替换材质逻辑
  }

  // 判定偏移校准按钮已静态做在 previewContainer 里，这里只绑定点击事件。
  private buildCalibButton(panel: Node): void {
    const btn = this.findByName(panel, 'calib_btn');
    if (!btn) return;
    btn.on(Button.EventType.CLICK, () => this.openCalibPopup());
  }

  // 创建校准弹窗（默认隐藏）：全屏遮罩(拦截列表触摸) + 面板(ui_bg) + 提示 + 采样区 + 移动 note + 关闭按钮。
  private buildCalibPopup(panel: Node): void {
    const mask = new Node('calib_mask');
    mask.setParent(panel);
    const mut = mask.addComponent(UITransform);
    mut.setContentSize(3000, 2000);
    mask.setPosition(0, 0, 0);
    mask.addComponent(BlockInputEvents); // 拦截弹窗背后的列表触摸
    mask.active = false;

    const popup = new Node('calib_popup');
    popup.setParent(mask);
    const put = popup.addComponent(UITransform);
    put.setContentSize(this.panelW, this.panelH);
    const psp = popup.addComponent(Sprite);
    psp.sizeMode = Sprite.SizeMode.CUSTOM;
    assetManager.loadAny({ uuid: UI_BG_SF }, (err: any, sf: SpriteFrame) => {
      if (!err && sf && popup.isValid) {
        const s = popup.getComponent(Sprite);
        if (s) s.spriteFrame = sf;
      }
    });

    // 顶部提示文字
    const hint = new Node('calib_hint');
    hint.setParent(popup);
    const hut = hint.addComponent(UITransform);
    hut.setContentSize(640, 50);
    hint.setPosition(0, this.panelH / 2 - 70, 0);
    const hl = hint.addComponent(Label);
    hl.string = 'note 到中线时点击（0/5）';
    hl.fontSize = 26;
    hl.color = new Color(255, 255, 255, 255);
    hl.horizontalAlign = Label.HorizontalAlign.CENTER;
    hl.verticalAlign = Label.VerticalAlign.CENTER;
    this.calibHint = hl;

    // 中部采样区（点击这里完成一次采样）
    const zone = new Node('calib_zone');
    zone.setParent(popup);
    const zut = zone.addComponent(UITransform);
    zut.setContentSize(this.panelW - 80, 120);
    zone.setPosition(0, -40, 0);
    zone.on(Node.EventType.TOUCH_END, () => this.onCalibZoneTap());

    // 移动的 note
    const note = new Node('calib_note');
    note.setParent(zone);
    const nut = note.addComponent(UITransform);
    nut.setContentSize(80, 80);
    note.setPosition(this.noteLeft, 0, 0);
    const nsp = note.addComponent(Sprite);
    nsp.sizeMode = Sprite.SizeMode.CUSTOM;
    resources.load('NoteImage/tap/spriteFrame', SpriteFrame, (err2: any, nsf: SpriteFrame) => {
      if (!err2 && nsf && note.isValid) {
        const s = note.getComponent(Sprite);
        if (s) s.spriteFrame = nsf;
      }
    });
    this.calibNote = note;

    // 中线（完美命中线）：note 越过此线即“完美”时刻，引导用户何时点击（音游校准的“引导系统”）
    const line = new Node('calib_line');
    line.setParent(zone);
    // 注意：Sprite 是依赖组件，addComponent(Sprite) 会自动附带 UITransform；
    // 必须先加 UITransform 再 addComponent(Sprite)，否则第二次 add 会报"已包含同一组件"。
    const lutt = line.addComponent(UITransform);
    lutt.setContentSize(6, 120);
    const lsp = line.addComponent(Sprite);
    lsp.sizeMode = Sprite.SizeMode.CUSTOM;
    lsp.color = new Color(255, 220, 90, 255); // 醒目金色
    line.setPosition(0, 0, 0);

    // 右上关闭按钮
    const close = new Node('calib_close');
    close.setParent(popup);
    const cut = close.addComponent(UITransform);
    cut.setContentSize(150, 56);
    close.setPosition(this.panelW / 2 - 90, this.panelH / 2 - 60, 0);
    const csp = close.addComponent(Sprite);
    csp.sizeMode = Sprite.SizeMode.CUSTOM;
    assetManager.loadAny({ uuid: UI_ROUND_SF }, (err3: any, csf: SpriteFrame) => {
      if (!err3 && csf && close.isValid) {
        const s = close.getComponent(Sprite);
        if (s) s.spriteFrame = csf;
      }
    });
    const closeLabel = new Node('calib_close_label');
    closeLabel.setParent(close);
    const clut = closeLabel.addComponent(UITransform);
    clut.setContentSize(120, 40);
    const clbl = closeLabel.addComponent(Label);
    clbl.string = '关闭';
    clbl.fontSize = 24;
    clbl.color = new Color(255, 255, 255, 255);
    clbl.horizontalAlign = Label.HorizontalAlign.CENTER;
    clbl.verticalAlign = Label.VerticalAlign.CENTER;
    const cbtn = close.addComponent(Button);
    cbtn.transition = Button.Transition.NONE;
    close.on(Button.EventType.CLICK, () => this.closeCalibPopup());

    this.calibMask = mask;
  }

  private openCalibPopup(): void {
    if (!this.calibMask || !this.calibNote || !this.calibHint) return;
    this.samples = [];
    this.calibDone = false;
    this.calibNote.setPosition(this.noteLeft, this.calibNote.position.y, 0);
    this.calibHint.string = 'note 到中线时点击（0/5）';
    this.calibMask.active = true;
  }

  private closeCalibPopup(): void {
    if (this.calibMask) this.calibMask.active = false;
  }

  // 点击采样区：note 越过中线(x=0)即“完美命中时刻”；x>0 说明点晚了 -> 偏移为正(偏晚)。
  private onCalibZoneTap(): void {
    if (!this.calibNote || !this.calibHint || this.calibDone) return;
    const x = this.calibNote.position.x;
    const offsetMs = Math.round((x / this.noteSpeed) * 1000);
    this.samples.push(offsetMs);
    const dir = offsetMs > 0 ? '偏晚' : (offsetMs < 0 ? '偏早' : '准');
    if (this.samples.length >= 5) {
      let avg = Math.round(this.samples.reduce((s, v) => s + v, 0) / this.samples.length);
      avg = Math.max(-500, Math.min(500, avg));
      this.settings.judgeOffset = avg;
      const sliderNode = this.findByName(this.node, 'judgeOffset_slider');
      const slider = sliderNode ? sliderNode.getComponent(Slider) : null;
      if (slider) slider.progress = (avg - (-500)) / 1000;
      const valNode = this.findByName(this.node, 'judgeOffset_val');
      const vl = valNode ? valNode.getComponent(Label) : null;
      if (vl) vl.string = String(avg) + 'ms';
      saveSettings(this.settings);
      this.applyPreviewJudgeOffset();
      this.samples = [];
      this.calibDone = true;
      const dirAvg = avg > 0 ? '偏晚' : (avg < 0 ? '偏早' : '准');
      this.calibHint.string = '已写入 ' + avg + ' ms（' + dirAvg + '），点“关闭”退出';
    } else {
      this.calibHint.string = '采样 ' + this.samples.length + '/5：' + dir + ' ' + Math.abs(offsetMs) + 'ms';
    }
  }

  update(dt: number) {
    if (!this.calibMask || !this.calibMask.active) return;
    if (!this.calibNote) return;
    let x = this.calibNote.position.x + this.noteSpeed * dt;
    if (x > this.noteRight) x = this.noteLeft;
    this.calibNote.setPosition(x, this.calibNote.position.y, 0);
  }

  // 左侧列表手动滚动：监听触摸位移差，直接改 content 的 y（替代 Cocos 自带 ScrollView）。
  // 面板始终可滚动——滑块水平拖动调音量时 dy≈0 不会带动面板；
  // 竖直拖动则面板滚动，而滑块 handle 的 x 不变、值不变，二者天然共存。
  // 滚动区间基于 content 子节点的真实包围盒动态计算（不依赖 content 静态 contentSize），
  // 滚到底 -> content 上移 -> content.y 增大。
  private setupScroll(panel: Node): void {
    const scrollNode = this.findByName(panel, 'settingsScroll');
    const content = this.findByName(panel, 'content');
    if (!scrollNode || !content) return;

    // 关闭 Cocos 自带滚动，滚动完全由下面手动逻辑驱动
    const sv = scrollNode.getComponent(ScrollView);
    if (sv) sv.enabled = false;

    const scrollTf = scrollNode.getComponent(UITransform);
    if (!scrollTf) return;
    const viewH = scrollTf.contentSize.height;

    // 动态计算 content 子节点的真实内容跨度（顶边最低/底边最高）
    let topLocal = -Infinity;
    let botLocal = Infinity;
    for (const child of content.children) {
      const tf = child.getComponent(UITransform);
      if (!tf) continue;
      const cy = child.position.y;
      const h = tf.contentSize.height;
      const ay = tf.anchorPoint.y;
      topLocal = Math.max(topLocal, cy + h * (1 - ay));
      botLocal = Math.min(botLocal, cy - h * ay);
    }
    if (topLocal === -Infinity || botLocal === Infinity) return;
    const span = topLocal - botLocal;

    const topY = content.position.y;                 // 初始：内容顶部对齐可视区顶
    const minY = topY + Math.max(0, span - viewH);   // 滚到底：content 上移，y 增大

    let dragging = false;
    let lastY = 0;

    scrollNode.on(Node.EventType.TOUCH_START, (e: EventTouch) => {
      dragging = true;
      lastY = e.getLocationY();
    });

    scrollNode.on(Node.EventType.TOUCH_MOVE, (e: EventTouch) => {
      if (!dragging) return;
      const dy = e.getLocationY() - lastY;   // 本帧手指位移：上滑为正
      lastY = e.getLocationY();
      let y = content.position.y + dy;        // 直接把 dy 加到节点上，跟随手指
      y = Math.min(minY, Math.max(topY, y));  // 夹在 [topY, minY]
      content.setPosition(content.position.x, y, 0);
    });

    const end = () => { dragging = false; };
    scrollNode.on(Node.EventType.TOUCH_END, end);
    scrollNode.on(Node.EventType.TOUCH_CANCEL, end);
  }

  // ===== 右侧实时预览：持续下落的 TAP 流 =====
  // 自包含轻量实现：直接加载贴图并用 tween 做直线飞行动画，不再复用游戏层的 NoteManager/NoteObject，
  // 避免设置场景缺少游戏初始化条件时重型管线崩溃。
  private initPreview(): void {
    const card = this.findByName(this.node, 'previewCard');
    if (!card) return;
    this.previewParent = card;

    // 并行加载谱面 + 音频 + 关键点贴图；note/关键点贴图由 NoteManager.preload 统一加载（与游戏内同一套资源）
    let loadedJson: JsonAsset | null = null;
    let loadedClip: AudioClip | null = null;
    let loadedKp: SpriteFrame | null = null;
    let jsonFailed = false;
    let audioFailed = false;
    let kpFailed = false;

    const tryStart = () => {
      if (!loadedJson && !jsonFailed) return;
      if (!loadedClip && !audioFailed) return;
      if (!loadedKp && !kpFailed) return;
      if (loadedJson) {
        this.previewChart = parseChart(loadedJson.json as ChartData);
      }
      if (!this.previewChart || this.previewChart.notes.length === 0) return;

      // 复用游戏内同一套：NoteManager(运动) + EndNodeManager(落点/触摸)
      this.previewNoteMgr = new NoteManager(card);
      this.previewEndMgr = new EndNodeManager(card);
      this.previewNoteMgr.preload().then(() => {
        if (!this.previewNoteMgr) return;
        this.previewKpFrame = loadedKp;
        this.buildPreviewJudgeLabel(card);
        this.buildSharedPreviewMarkers();
        // 顺序：先记录音乐起点并播放音频，再启动 note 流（与 GameDirector.start 一致：
        // gameStartTime=Date.now() 紧接 playBgm，随后 scheduleNote）
        if (loadedClip) this.startPreviewAudio(loadedClip);
        this.startPreviewStream();
        // 整个演示区(previewCard)都视为有效打击区：点卡片内任意位置都触发一次判定采样
        this.previewParent?.on(Node.EventType.TOUCH_END, () => this.onPreviewTap());
        // 调试用：空格键也走同一套判定（无需每次去点卡片）。event.repeat 过滤长按自动重复，保证一次物理按下=一次采样
        input.on(Input.EventType.KEY_DOWN, this.onPreviewKeyDown, this);
      });
    };

    resources.load('gameJson/PreviewChart', JsonAsset, (err, json) => {
      if (err || !json) jsonFailed = true;
      else loadedJson = json;
      tryStart();
    });
    resources.load('music/drumLoop8', AudioClip, (err, clip) => {
      if (err || !clip) audioFailed = true;
      else loadedClip = clip;
      tryStart();
    });
    resources.load('keypointimage/endimage/spriteFrame', SpriteFrame, (err, sf) => {
      if (err || !sf) kpFailed = true;
      else loadedKp = sf;
      tryStart();
    });
  }

  /** 在预览卡片上创建“一套”共享 keynote/startnode/endnode：起点(顶)与终点(底)灰环标记各一个，常驻、位置写死 json keypoint。
   *  所有 note 共用这一套几何；note 自身从对象池独立拉出/运动/抵达/回池，互不耦合。 */
  private buildSharedPreviewMarkers(): void {
    const card = this.previewParent;
    const chart = this.previewChart;
    if (!card || !chart || chart.notes.length === 0 || !this.previewKpFrame || !this.previewEndMgr) return;
    const p = chart.notes[0];
    const scale = getLayoutScale();
    const skp = p.keypoint.map(v => v * scale);
    const sx = skp[0], sy = skp[1], ex = skp[skp.length - 2], ey = skp[skp.length - 1];
    this.previewPathBase = { sx, sy, ex, ey };
    this.previewTravelMs = p.travelMs;

    // 共享起点标记(顶)：一个灰环，常驻、固定
    if (!this.previewStartMarker) {
      const start = new Node('PreviewStartMarker');
      start.setParent(card);
      const sut = start.addComponent(UITransform); sut.setContentSize(64, 64);
      const ssp = start.addComponent(Sprite); ssp.spriteFrame = this.previewKpFrame;
      start.position.set(sx, sy, 0);
      this.previewStartMarker = start;
    }
    // 共享终点标记(底)：一个灰环，常驻、固定；同时作为所有 note 的飞行目标(endNode)
    const endNode = this.previewEndMgr.createOrGet(p.endpointname);
    if (!endNode.getComponent(UITransform)) {
      const eut = endNode.addComponent(UITransform); eut.setContentSize(64, 64);
    }
    const esp = endNode.getComponent(Sprite);
    if (esp) { esp.spriteFrame = this.previewKpFrame; esp.color = new Color(255, 255, 255, 255); }
    endNode.setPosition(ex, ey, 0);
    this.previewEndMarker = endNode;
    this.previewActiveEndNode = endNode;

    // 判定文字锚定到终点标记正下方
    this.applyPreviewJudgeOffset();
  }

  /** 在预览卡片上动态建一个判定文字 Label（显示 Perfect/Great/Miss + 偏移），由触摸回调刷新 */
  private buildPreviewJudgeLabel(card: Node): void {
    const n = new Node('PreviewJudge');
    n.setParent(card);
    n.addComponent(UITransform);
    const lab = n.addComponent(Label);
    lab.string = '';
    lab.fontSize = 28;
    lab.lineHeight = 32;
    lab.color = new Color(255, 255, 255, 255);
    n.position = new Vec3(0, -240, 0);  // 初始置于落点(灰环)正下方（贝塞尔延长线方向），运行时由 applyPreviewJudgeOffset 跟随灰环同步
    const op = n.addComponent(UIOpacity);
    op.opacity = 0;
    this.previewJudgeLabel = lab;
  }

  /** 刷新判定文字并淡出（与 HUD.flashJudge 同源逻辑，但独立 Label 以免污染游戏 HUD） */
  private showPreviewJudge(result: JudgeResult, diffMs: number): void {
    if (!this.previewJudgeLabel) return;
    const node = this.previewJudgeLabel.node;
    // Miss 表示“该 note 从未被点过”，本质无时间差；若仍显示 diff 会把 judgeOffset 漏进来误导，故 Miss 不显示毫秒
    const diffStr = result === JudgeResult.Miss ? '' : ` ${diffMs >= 0 ? '+' : ''}${Math.round(diffMs)}ms`;
    this.previewJudgeLabel.string = `${result}${diffStr}`;
    const colorMap: Record<JudgeResult, Color> = {
      [JudgeResult.Perfect]: new Color(255, 215, 0),
      [JudgeResult.Great]: new Color(0, 200, 255),
      [JudgeResult.Miss]: new Color(255, 80, 80),
    };
    this.previewJudgeLabel.color = colorMap[result] ?? new Color(255, 255, 255);
    const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    op.opacity = 255;
    tween(op).to(0.5, { opacity: 0 }).start();
  }

  /** 用已加载的 8 拍鼓点启动循环播放，并记录音乐起点（判定 elapsed 基准，与 GameDirector 一致） */
  private startPreviewAudio(clip: AudioClip): void {
    const card = this.previewParent;
    if (!card) return;
    const src = card.getComponent(AudioSource) || card.addComponent(AudioSource);
    src.clip = clip;
    src.loop = true;
    src.volume = 0.8;
    src.play();
    this.previewGameStartTime = Date.now();
    this.previewAudioSource = src;
    if (clip.duration > 0) this.previewAudioClipDuration = clip.duration;
  }

  /** 启动 note 流：改为每帧检测音频时钟，按 travelSec 节拍网格锁相 spawn，
   *  保证 note 出现/落点严格绑定音频实际出声进度（消除 play() 缓冲延迟导致的漂移） */
  private startPreviewStream(): void {
    if (this.previewStreamScheduled) return;
    this.previewStreamScheduled = true;
    this.previewNextBeat = 0;
    this.previewAudioTimeAccum = 0;
    this.previewLastCurrentTime = 0;
    this.schedule(this.updatePreviewSpawn, 0); // 每帧
  }

  /** 每帧：以音频 currentTime 为基准，每跨过一个 travelSec 网格就 spawn 一个 note（相位锚定音频）。
   *  等音频真正开始出声(currentTime>0)后才 spawn，消除首拍缓冲偏移——实现“音频和 json 一起跑”。 */
  private updatePreviewSpawn(): void {
    const src = this.previewAudioSource;
    const chart = this.previewChart;
    if (!src || !chart || chart.notes.length === 0) return;
    if (src.currentTime <= 0) return; // 音频尚未真正出声前不 spawn（首拍对齐到出声瞬间）
    const travelSec = Math.max(0.05, chart.notes[0].travelMs / 1000);
    // 处理音频循环回绕：currentTime 从 clip 末尾跳回 0 时累加 clip 长度，保持“累计音频时间”单调，避免回绕瞬间重复 spawn。
    if (src.currentTime < this.previewLastCurrentTime - 0.5) {
      this.previewAudioTimeAccum += this.previewAudioClipDuration;
    }
    this.previewLastCurrentTime = src.currentTime;
    const audioElapsed = this.previewAudioTimeAccum + src.currentTime;
    // 判定偏移同时影响“还没出现的 note”的出现时间和“已在屏上的 note”的位置：
    // - 出现阈值 = 网格时刻 + 当前 judgeOffset(实时读取)，跨阈值才 spawn；
    // - 位置由 updatePreviewSpawn 每帧重算：progress = (rawElapsed - spawnElapsed - judgeOffset) / travelMs，
    //   拖动滑块时正在飞的 note 位置实时跟着变（类似参考视频效果）。
    const off = this.settings.judgeOffset / 1000;
    // 判定偏移只在“下一个还没出现的 note”出生时读取：阈值 = 网格时刻 + 当前 judgeOffset(实时)。
    // 每次最多出 1 个(if 而非 while)：避免掉帧/音频回绕瞬间一次性补出多个 note 叠成连续流。
    if (this.previewNextBeat >= 0 && audioElapsed >= this.previewNextBeat * travelSec + off) {
      this.previewNextBeat += this.previewSpawnEveryBeats;
      this.spawnPreviewNote();
    }

    // ===== 每帧更新所有活跃 note 位置：根据当前 judgeOffset 实时重算 progress，offset 改变时 note 位置跟着动 =====
    const rawElapsed = this.previewRawElapsedMs();
    const travelMs = this.previewTravelMs;
    const path = this.previewPathBase;
    if (path && this.previewPending.length > 0) {
      const { sx, sy, ex, ey } = path;
      // 倒序遍历，方便在循环内移除已到达的 note
      for (let i = this.previewPending.length - 1; i >= 0; i--) {
        const item = this.previewPending[i];
        const progress = (rawElapsed - item.spawnElapsed - this.settings.judgeOffset) / travelMs;
        if (progress >= 1) {
          // 到达终点：判 Miss（若未点）并回收
          this.previewOnNoteArriveAtIndex(i);
        } else {
          // 更新位置：progress 可能 <0（offset 很大负值把 note 推后到还没出生），此时 clamp 到起点
          const t = Math.max(0, progress);
          const x = sx + (ex - sx) * t;
          const y = sy + (ey - sy) * t;
          item.note.node.position.set(x, y, 0);
          item.note.node.active = true;
        }
      }
    }
  }

  /** 用游戏内同一套生成一个可玩 TAP：飞行终点 = 共享终点标记(previewEndMarker，常驻、固定) + NoteManager 生成 note 并下落。
   *  每个 note 独立：从对象池拉出 -> 各自 tween 运动 -> 各自 onArrive 抵达终点 -> 各自 recycle 回池。
   *  判定改为演示区任意点击(在 onPreviewTap 中处理)，点击不回收、note 继续走、到终点才结算/回收。 */
  private spawnPreviewNote(): void {
    const mgr = this.previewNoteMgr;
    const emgr = this.previewEndMgr;
    const chart = this.previewChart;
    if (!mgr || !emgr || !chart || chart.notes.length === 0) return;

    const p = chart.notes[0];
    const travelSec = Math.max(0.05, p.travelMs / 1000);

    // 飞行终点 = 共享终点标记（一套 keynote/start/end 中的 endnode，常驻、位置写死 json 终点），所有 note 共用。
    const endNode = emgr.createOrGet(p.endpointname);

    const note = mgr.spawn(p, endNode, this.settings.trackOn, 1);
    // 每 note 自带的 startNode/middleNodes/endKeyNode 会淡入并与“共享那一套”叠出重复环 -> 整个停用，只用共享几何。
    if (note.startNode) note.startNode.active = false;
    note.middleNodes.forEach(m => { m.active = false; });
    if (note.endKeyNode) note.endKeyNode.active = false;

    // 记录该 note 的出生时刻(相对音乐起点、固定不变)。位置由 updatePreviewSpawn 每帧根据当前 judgeOffset 实时重算：
    // progress = (rawElapsed - spawnElapsed - judgeOffset) / travelMs。
    // offset 改变时 progress 实时变 → note 位置跟着变（类似参考视频里拖动 offset 滑块的效果）。
    const spawnElapsed = Date.now() - this.previewGameStartTime;
    this.previewPending.push({ note, spawnElapsed, tapped: false });
    this.previewSpawnCount++;

    // 不调用 note.startMove()：预览 note 的运动由 updatePreviewSpawn 每帧手动控制，
    // 这样 judgeOffset 改变时能实时反映到正在飞的 note 位置上（固定 tween 做不到）。
    // note.startMove(travelSec, () => this.previewOnNoteArrive(note));
  }

  /** 判定文字落点：终点标记正下方(贝塞尔延长线方向 = 垂直向下)。起点/终点均为 json 写死固定值，
   *  judgeOffset 不再移动任何节点——它现在只决定“下一个还没出现的 note”的出现时间(updatePreviewSpawn 里实时读取)。
   *  屏幕上所有 note 与共享 start/end 标记位置都只由 json 端点决定。 */
  private applyPreviewJudgeOffset(): void {
    if (!this.previewPathBase) return;
    const { ex, ey } = this.previewPathBase;
    if (this.previewJudgeLabel) {
      this.previewJudgeLabel.node.position.set(ex, ey - 36, 0);
    }
  }

  /** 判定基准：与游戏内 onEndpointTouch 完全一致 —— (Date.now - 音乐起点) + judgeOffset。
   *  音乐起点取音频 play 时刻（与 GameDirector.playBgm 一致）；用系统时钟保证单调、不随音频循环回绕。 */
  private previewElapsedMs(): number {
    return (Date.now() - this.previewGameStartTime) + this.settings.judgeOffset;
  }

  /** 原始流逝时间（不含 judgeOffset）：用于计算 note 位置进度，保证 offset 改变时正在飞的 note 位置实时跟着变。 */
  private previewRawElapsedMs(): number {
    return Date.now() - this.previewGameStartTime;
  }

  /** 演示区任意点击：取当前最接近目标时刻的活跃 note，算相差时间并显示判定（与游戏内窗口一致）。
   *  点击不回收 note —— tap 继续走、到终点前可再次点击刷新判定；tapped 标记仅用于“到终点是否判 Miss”。 */
  private onPreviewTap(): void {
    // 点击只判定、不生成 note：没活跃 note 时静默返回。
    if (this.previewPending.length === 0) return;
    const elapsed = this.previewElapsedMs(); // = (now - 音乐起点) + judgeOffset
    let best = this.previewPending[0];
    let bestTargetMs = best.spawnElapsed + this.previewTravelMs + this.settings.judgeOffset;
    let bestDiff = Math.abs(elapsed - bestTargetMs);
    for (const it of this.previewPending) {
      const targetMs = it.spawnElapsed + this.previewTravelMs + this.settings.judgeOffset;
      const d = Math.abs(elapsed - targetMs);
      if (d < bestDiff) { bestDiff = d; best = it; }
    }
    best.tapped = true;
    // 触控命中即至少 Great（与 JudgeSystem.resolveTouch 规则一致：窗口外点击仍算 Great，Miss 仅由到终点兜底）
    const result = bestDiff <= 50 ? JudgeResult.Perfect : JudgeResult.Great;
    this.showPreviewJudge(result, bestDiff);
  }

  /** 调试用空格键回调：与 onPreviewTap 走完全相同的判定逻辑（取最接近目标时刻的活跃 note 算相差时间） */
  private onPreviewKeyDown(event: EventKeyboard): void {
    if (event.keyCode === KeyCode.SPACE && !event.repeat) this.onPreviewTap();
  }

  /** 音符到达落点（由 updatePreviewSpawn 每帧检测 progress>=1 时调用）：若从未点击则判 Miss，否则仅回收。 */
  private previewOnNoteArriveAtIndex(idx: number): void {
    const item = this.previewPending[idx];
    if (!item.tapped) {
      const elapsed = this.previewElapsedMs();
      const targetMs = item.spawnElapsed + this.previewTravelMs + this.settings.judgeOffset;
      this.showPreviewJudge(JudgeResult.Miss, Math.abs(elapsed - targetMs));
    }
    this.previewNoteMgr?.recycleNote(item.note, 0.08);
    this.previewPending.splice(idx, 1);
  }

  /** 兼容接口：通过 note 引用找到索引再处理（旧 tween 回调用，现预览已改为手动控制，此接口保留以防万一）。 */
  private previewOnNoteArrive(note: NoteObject): void {
    const idx = this.previewPending.findIndex(it => it.note === note);
    if (idx >= 0) this.previewOnNoteArriveAtIndex(idx);
  }

  onDestroy(): void {
    this.unscheduleAllCallbacks();
    input.off(Input.EventType.KEY_DOWN, this.onPreviewKeyDown, this); // 移除调试空格键监听
    if (this.previewAudioSource) { this.previewAudioSource.stop(); this.previewAudioSource = null; }
    this.previewEndMgr?.reset();   // 清理落点节点 + 触摸绑定（previewNoteMgr 活跃 note 随场景销毁自动回收）
    this.previewNoteMgr = null;
    this.previewEndMgr = null;
    this.previewJudgeLabel = null;
    this.previewPending = [];      // 释放活跃 note 引用（节点随场景销毁回收）
    this.previewSpawnCount = 0;
    if (this.previewStartMarker && this.previewStartMarker.isValid) this.previewStartMarker.destroy();
    this.previewStartMarker = null;
    this.previewEndMarker = null;
    this.previewActiveEndNode = null;
    this.previewPathBase = null;
    this.previewNextBeat = 0;
    this.previewAudioTimeAccum = 0;
    this.previewLastCurrentTime = 0;
  }
}
