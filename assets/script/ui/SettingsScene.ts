import { _decorator, Component, Node, Slider, Label, Button, director, sys } from 'cc';
const { ccclass, property } = _decorator;

const SETTINGS_KEY = 'werhythm_settings';

interface Settings {
  judgeOffset: number;
  bgDim: number;
  musicVol: number;
  sfxVol: number;
  noteSize: number;
  fxOn: number;
  trackOn: number;
  playMode: number;
}

const DEFAULTS: Settings = {
  judgeOffset: 0,
  bgDim: 100,
  musicVol: 80,
  sfxVol: 80,
  noteSize: 1,
  fxOn: 1,
  trackOn: 1,
  playMode: 0,
};

@ccclass('SettingsScene')
export class SettingsScene extends Component {
  private settings: Settings = { ...DEFAULTS };

  onLoad() {
    const panel = this.node; // Canvas
    this.loadSettings();

    // sliders
    this.wireSlider(panel, 'judgeOffset', -100, 100, 5, 0);
    this.wireSlider(panel, 'bgDim', 0, 100, 5, 100);
    this.wireSlider(panel, 'musicVol', 0, 100, 5, 80);
    this.wireSlider(panel, 'sfxVol', 0, 100, 5, 80);

    // toggles
    this.wireToggle(panel, 'noteSize', ['小', '中', '大'], 1);
    this.wireToggle(panel, 'fxOn', ['关', '开'], 1);
    this.wireToggle(panel, 'trackOn', ['关', '开'], 1);
    this.wireToggle(panel, 'playMode', ['4K', '5K', '6K'], 0);

    const back = panel.getChildByName('返回');
    if (back) back.on(Button.EventType.CLICK, () => director.loadScene('start'));
  }

  private loadSettings() {
    try {
      const raw = sys.localStorage.getItem(SETTINGS_KEY);
      if (raw) this.settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
  }

  private saveSettings() {
    try {
      sys.localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (e) { /* ignore */ }
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

  private wireSlider(panel: Node, key: string, min: number, max: number, step: number, def: number) {
    const sliderNode = this.findByName(panel, 'row_' + key + '_slider');
    const valNode = this.findByName(panel, 'row_' + key + '_val');
    if (!sliderNode) return;
    const slider = sliderNode.getComponent(Slider);
    const valLabel = valNode ? valNode.getComponent(Label) : null;

    const cur = this.settings[key as keyof Settings] as number;
    if (slider) {
      const span = max - min;
      slider.progress = span > 0 ? (cur - min) / span : 0;
      slider.node.on('slide', (s: Slider) => {
        let v = min + s.progress * span;
        v = Math.round(v / step) * step;
        v = Math.max(min, Math.min(max, v));
        (this.settings as any)[key] = v;
        if (valLabel) valLabel.string = String(v);
        this.saveSettings();
      });
    }
    if (valLabel) valLabel.string = String(cur);
  }

  private wireToggle(panel: Node, key: string, vals: string[], def: number) {
    const btnNode = this.findByName(panel, 'row_' + key + '_btn');
    if (!btnNode) return;
    const dispNode = this.findByName(btnNode, 'row_' + key + '_disp');
    const dispLabel = dispNode ? dispNode.getComponent(Label) : null;

    let idx = this.settings[key as keyof Settings] as number;
    if (idx < 0 || idx >= vals.length) idx = def;

    const refresh = () => {
      if (dispLabel) dispLabel.string = vals[idx];
    };
    refresh();

    btnNode.on(Button.EventType.CLICK, () => {
      idx = (idx + 1) % vals.length;
      (this.settings as any)[key] = idx;
      refresh();
      this.saveSettings();
    });
  }
}
