import { _decorator, Component, Node, Slider, Label, Button, ScrollView, director, resources, JsonAsset, SpriteFrame, Sprite, Vec3, tween, EventTouch, UITransform, UIOpacity, Color, BlockInputEvents, AudioSource, AudioClip, Input, input, KeyCode, EventKeyboard } from 'cc';
import { loadSettings, saveSettings } from '../core/Settings';
import { SettingsData, ChartData, JudgeResult } from '../core/types';
import { parseChart, ParsedChart, ParsedNote } from '../core/ChartParser';
import { NoteManager } from '../gameplay/NoteManager';
import { EndNodeManager } from '../gameplay/EndNodeManager';
import { NoteObject } from '../gameplay/NoteObject';
import { getLayoutScale } from '../util/layout';
const { ccclass, property } = _decorator;

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

  // 预览判定（自包含，不依赖 EndNodeManager 的 register/autoMiss）：每个活跃 note 记出生物理时间(spawnRawMs)，
  // 位置由 updatePreviewSpawn 每帧根据「经过时间/travelMs」重算；触摸任意演示区都算一次判定（不回收，到终点才结算）。
  private previewPending: { note: NoteObject; spawnRawMs: number; tapped: boolean }[] = [];
  private previewSpawnCount = 0;
  private diagTick = 0;                     // 诊断用：每 60 帧输出一次状态

  // 判定偏移校准弹窗（参考 Arcaea / BanG Dream：放鼓点 -> 听声点击 -> 采样求平均写 offset）
  private calibMask: Node | null = null;   // 全屏遮罩（含面板），active 控制开关
  private calibHint: Label | null = null;  // 提示文字
  private calibDiff: Label | null = null;  // 每次点击后的偏差值显示
  private calibProgress: Label | null = null; // 进度 "n/N"
  private samples: number[] = [];
  private calibCount = 3;                  // 采样次数（3~4 组，不用太多）
  private calibBeatSec = 0.5;              // 鼓点间隔(秒)，与 drumLoop8 的 120BPM 一致

  onLoad() {
    console.log('[preview] 版本 v23.10-offset出生时机 | 当前 offset=', loadSettings().judgeOffset);
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

    // 绑定“判定偏移校准”按钮 + 创建校准面板
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

  // 判定偏移校准按钮（场景静态节点）：点击弹出校准面板。
  private buildCalibButton(panel: Node): void {
    const btn = this.findByName(panel, 'calib_btn');
    if (!btn) return;
    btn.on(Button.EventType.CLICK, () => this.openCalibPopup());
  }

  // 创建校准面板（默认隐藏）。参考 Arcaea / BanG Dream：放鼓点 -> 听重音点按钮 -> 采样求平均写 offset。
  // 纯色绘制，不用 AI 贴图、无水印。
  private buildCalibPopup(panel: Node): void {
    const mask = new Node('calib_mask');
    mask.setParent(panel);
    const mut = mask.addComponent(UITransform);
    mut.setContentSize(3000, 2000);
    mask.setPosition(0, 0, 0);
    mask.addComponent(BlockInputEvents); // 拦截背后的列表触摸（采样走中间按钮，不绑遮罩）
    mask.active = false;

    // 框（不透明浅色，与设置面板同款）
    const popup = new Node('calib_popup');
    popup.setParent(mask);
    const put = popup.addComponent(UITransform);
    put.setContentSize(720, 440);
    const psp = popup.addComponent(Sprite);
    psp.sizeMode = Sprite.SizeMode.CUSTOM;
    psp.color = new Color(235, 235, 242, 255);

    // 提示文字
    const hint = new Node('calib_hint');
    hint.setParent(popup);
    const hut = hint.addComponent(UITransform);
    hut.setContentSize(640, 60);
    hint.setPosition(0, 150, 0);
    const hl = hint.addComponent(Label);
    hl.string = '听到重音就点按钮';
    hl.fontSize = 30;
    hl.color = new Color(26, 26, 46, 255);
    hl.horizontalAlign = Label.HorizontalAlign.CENTER;
    hl.verticalAlign = Label.VerticalAlign.CENTER;
    this.calibHint = hl;

    // 中间采样按钮（纯色，无水印）
    const tapBtn = new Node('calib_tap');
    tapBtn.setParent(popup);
    const tut = tapBtn.addComponent(UITransform);
    tut.setContentSize(320, 120);
    tapBtn.setPosition(0, 30, 0);
    const tsp = tapBtn.addComponent(Sprite);
    tsp.sizeMode = Sprite.SizeMode.CUSTOM;
    tsp.color = new Color(26, 26, 46, 255);
    const tapLabel = new Node('calib_tap_label');
    tapLabel.setParent(tapBtn);
    const tlutt = tapLabel.addComponent(UITransform);
    tlutt.setContentSize(280, 60);
    const tlbl = tapLabel.addComponent(Label);
    tlbl.string = '点这里';
    tlbl.fontSize = 32;
    tlbl.color = new Color(255, 255, 255, 255);
    tlbl.horizontalAlign = Label.HorizontalAlign.CENTER;
    tlbl.verticalAlign = Label.VerticalAlign.CENTER;
    const tbtn = tapBtn.addComponent(Button);
    tbtn.transition = Button.Transition.NONE;
    tapBtn.on(Button.EventType.CLICK, () => this.onCalibTap());

    // 偏差值显示
    const diff = new Node('calib_diff');
    diff.setParent(popup);
    const dut = diff.addComponent(UITransform);
    dut.setContentSize(640, 50);
    diff.setPosition(0, -70, 0);
    const dl = diff.addComponent(Label);
    dl.string = '偏差：--';
    dl.fontSize = 28;
    dl.color = new Color(26, 26, 46, 255);
    dl.horizontalAlign = Label.HorizontalAlign.CENTER;
    dl.verticalAlign = Label.VerticalAlign.CENTER;
    this.calibDiff = dl;

    // 进度文字
    const prog = new Node('calib_progress');
    prog.setParent(popup);
    const prut = prog.addComponent(UITransform);
    prut.setContentSize(640, 50);
    prog.setPosition(0, -130, 0);
    const pl = prog.addComponent(Label);
    pl.string = '0 / ' + this.calibCount;
    pl.fontSize = 26;
    pl.color = new Color(120, 120, 135, 255);
    pl.horizontalAlign = Label.HorizontalAlign.CENTER;
    pl.verticalAlign = Label.VerticalAlign.CENTER;
    this.calibProgress = pl;

    // 关闭按钮
    const close = new Node('calib_close');
    close.setParent(popup);
    const cut = close.addComponent(UITransform);
    cut.setContentSize(160, 56);
    close.setPosition(0, -185, 0);
    const csp = close.addComponent(Sprite);
    csp.sizeMode = Sprite.SizeMode.CUSTOM;
    csp.color = new Color(205, 205, 215, 255);
    const closeLabel = new Node('calib_close_label');
    closeLabel.setParent(close);
    const clut = closeLabel.addComponent(UITransform);
    clut.setContentSize(120, 40);
    const clbl = closeLabel.addComponent(Label);
    clbl.string = '关闭';
    clbl.fontSize = 24;
    clbl.color = new Color(26, 26, 46, 255);
    clbl.horizontalAlign = Label.HorizontalAlign.CENTER;
    clbl.verticalAlign = Label.VerticalAlign.CENTER;
    const cbtn = close.addComponent(Button);
    cbtn.transition = Button.Transition.NONE;
    close.on(Button.EventType.CLICK, () => this.closeCalibPopup());

    this.calibMask = mask;
  }

  private openCalibPopup(): void {
    if (!this.calibMask) return;
    this.samples = [];
    if (this.calibHint) this.calibHint.string = '听到重音就点按钮';
    if (this.calibDiff) this.calibDiff.string = '偏差：--';
    if (this.calibProgress) this.calibProgress.string = '0 / ' + this.calibCount;
    // 点按钮是用户手势，此时重新 play 可绕过浏览器 autoplay 限制，确保鼓点真出声（currentTime 从 0 重新循环）
    const src = this.previewAudioSource;
    if (src) { src.stop(); src.play(); }
    this.calibMask.active = true;
  }

  private closeCalibPopup(): void {
    if (this.calibMask) this.calibMask.active = false;
  }

  // 听重音点按钮采样：读预览音频 currentTime，算“点击相对最近鼓点”的偏差(ms)。>0 点晚、<0 点早。
  private onCalibTap(): void {
    if (!this.calibMask || !this.calibMask.active) return;
    if (this.samples.length >= this.calibCount) return;
    const src = this.previewAudioSource;
    if (!src || src.currentTime <= 0) {
      if (this.calibHint) this.calibHint.string = '音频未就绪，先点一下预览区再试';
      return;
    }
    const t = src.currentTime; // 秒
    const beat = Math.round(t / this.calibBeatSec);
    const diffMs = Math.round((t - beat * this.calibBeatSec) * 1000);
    this.samples.push(diffMs);
    const dir = diffMs > 0 ? '偏晚' : (diffMs < 0 ? '偏早' : '准');
    if (this.samples.length >= this.calibCount) {
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
      const dirAvg = avg > 0 ? '偏晚' : (avg < 0 ? '偏早' : '准');
      if (this.calibDiff) this.calibDiff.string = '平均：' + (avg >= 0 ? '+' : '') + avg + 'ms（' + dirAvg + '）';
      if (this.calibHint) this.calibHint.string = '已写入 ' + avg + ' ms，点“关闭”退出';
      if (this.calibProgress) this.calibProgress.string = this.calibCount + ' / ' + this.calibCount;
    } else {
      if (this.calibDiff) this.calibDiff.string = '偏差：' + (diffMs >= 0 ? '+' : '') + diffMs + 'ms（' + dir + '）';
      if (this.calibHint) this.calibHint.string = '第 ' + this.samples.length + ' 次采样';
      if (this.calibProgress) this.calibProgress.string = this.samples.length + ' / ' + this.calibCount;
    }
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
    if (!card) { console.log('[preview] previewCard 节点没找到！'); return; }
    this.previewParent = card;
    console.log('[preview] initPreview 开始, card=', card.name);

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
      console.log('[preview] 三项加载完成 | json=', !jsonFailed, '| clip=', !audioFailed, '| kp=', !kpFailed);
      if (loadedJson) {
        this.previewChart = parseChart(loadedJson.json as ChartData);
      }
      if (!this.previewChart || this.previewChart.notes.length === 0) {
        console.log('[preview] 谱面解析失败或 notes 为空 | chart=', !!this.previewChart);
        return;
      }

      // 复用游戏内同一套：NoteManager(运动) + EndNodeManager(落点/触摸)
      this.previewNoteMgr = new NoteManager(card);
      this.previewEndMgr = new EndNodeManager(card);
      this.previewNoteMgr.preload().then(() => {
        if (!this.previewNoteMgr) return;
        console.log('[preview] preload 完成');
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
      }).catch((e: any) => {
        console.log('[preview] preload 失败！', e);
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
    // 一次性诊断：定位 tap 不动时是哪一步断了（gameStart/chart/pathBase/travelMs 哪个是 0/null）
    console.log('[preview] stream start | gameStartMs=', this.previewGameStartTime,
      '| chart=', !!this.previewChart, '| pathBase=', !!this.previewPathBase,
      '| travelMs=', this.previewTravelMs, '| audio=', !!this.previewAudioSource);
    this.schedule(this.updatePreviewSpawn, 0); // 每帧
  }

  /** 每帧：以 Date.now 时钟（相对音乐起点 previewGameStartTime）为基准，每跨过一个 travelMs 网格 spawn 一个 note，
   *  并每帧用「经过时间 / travelMs」重算 note 位置（纯物理时间，不含 offset，保证 note 一定平滑下落）。 */
  private updatePreviewSpawn(): void {
    const chart = this.previewChart;
    if (!chart || chart.notes.length === 0) return;
    // 音乐起点未记录（音频未成功 play）则不启动流，避免 Date.now 基准错误导致疯狂 spawn
    if (this.previewGameStartTime <= 0) return;
    const travelMs = this.previewTravelMs;
    const rawElapsed = this.previewRawElapsedMs(); // Date.now - 音乐起点（毫秒）
    // 诊断：每 30 帧(约0.5s)输出一次，看 spawn 是否推进、note 位置是否变化
    this.diagTick = (this.diagTick || 0) + 1;
    if (this.diagTick % 30 === 1) {
      const p0 = this.previewPending[0];
      console.log('[preview] tick', this.diagTick, '| rawElapsed=', Math.round(rawElapsed),
        '| nextBeat=', this.previewNextBeat, '| pending=', this.previewPending.length,
        '| spawnCount=', this.previewSpawnCount,
        '| p0=', p0 ? ('spawn=' + Math.round(p0.spawnRawMs) + ',nodeY=' + Math.round(p0.note.node.position.y)) : 'none');
    }
    // spawn：offset 只决定 note 的出生时机。judgeOffset 负 = 晚出生（阈值增大、延后出现），正 = 早出生。
    if (this.previewNextBeat >= 0 && rawElapsed >= this.previewNextBeat * travelMs - this.settings.judgeOffset) {
      this.previewNextBeat += this.previewSpawnEveryBeats;
      this.spawnPreviewNote(rawElapsed);
    }

    // ===== 每帧更新所有活跃 note 位置 =====
    // progress = (rawElapsed - spawnRawMs) / travelMs = 经过时间/时长。offset 只决定 note 的出生时机（spawn 条件里），
    // 出生后 note 从起点(progress 0)正常下落到终点(progress 1)，位置不随 offset 二次偏移。
    const path = this.previewPathBase;
    if (path && this.previewPending.length > 0) {
      const { sx, sy, ex, ey } = path;
      // 倒序遍历，方便在循环内移除已到达的 note
      for (let i = this.previewPending.length - 1; i >= 0; i--) {
        const item = this.previewPending[i];
        const t = Math.max(0, Math.min(1, (rawElapsed - item.spawnRawMs) / travelMs));
        if (t >= 1) {
          // 到达终点：判 Miss（若未点）并回收
          this.previewOnNoteArriveAtIndex(i);
        } else {
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
  private spawnPreviewNote(spawnRawMs: number): void {
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

    // 一次性诊断：输出 note 头节点的关键渲染状态（只在第 1、2 个 note 时输出，避免刷屏）
    if (this.previewSpawnCount <= 2) {
      const sp = note.node.getComponent(Sprite);
      const ut = note.node.getComponent(UITransform);
      console.log('[preview] note 渲染状态 | name=', note.node.name,
        '| active=', note.node.active,
        '| spriteFrame=', !!sp?.spriteFrame,
        '| colorA=', sp?.color.a,
        '| utSize=', ut ? (ut.contentSize.width + 'x' + ut.contentSize.height) : 'null',
        '| localPos=', Math.round(note.node.position.x) + ',' + Math.round(note.node.position.y),
        '| worldPos=', Math.round(note.node.worldPosition.x) + ',' + Math.round(note.node.worldPosition.y),
        '| layer=', note.node.layer);
    }

    // 记录出生时的物理时间（固定）。位置由 updatePreviewSpawn 用「经过时间 / travelMs」重算，
    // 出生时 progress 精确为 0（起点），单调递增到 1（终点）。
    this.previewPending.push({ note, spawnRawMs, tapped: false });
    this.previewSpawnCount++;

    // 不调用 note.startMove()：预览 note 的运动由 updatePreviewSpawn 每帧手动控制（纯物理时间，稳定可靠）。
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
    let bestTargetMs = best.spawnRawMs + this.previewTravelMs + this.settings.judgeOffset;
    let bestDiff = Math.abs(elapsed - bestTargetMs);
    for (const it of this.previewPending) {
      const targetMs = it.spawnRawMs + this.previewTravelMs + this.settings.judgeOffset;
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
      const targetMs = item.spawnRawMs + this.previewTravelMs + this.settings.judgeOffset;
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
