// 音频管理：旧工程是"哑"的（不挂 AudioSource，调音量不出声）。这里补上：
// - BGM：复用游戏节点上的 AudioSource（或动态创建），加载 music 目录音频并播放，受 musicVol 控制。
// - SFX：命中时播放短音效，受 sfxVol 控制。
// 所有加载/播放都带容错：缺资源不会崩，只是没声音。

import { AudioSource, AudioClip, resources, Node } from 'cc';

export class AudioManager {
    private node: Node;
    private bgmSource?: AudioSource;
    private sfxSource?: AudioSource;
    private bgmClip?: AudioClip;
    private sfxClip?: AudioClip;
    private musicVol = 80;
    private sfxVol = 80;

    constructor(node: Node) {
        this.node = node;
    }

    /** 把场景中已有的 AudioSource 作为 BGM 源（旧流程：游戏节点挂 AudioSource） */
    attachBgmSource(src: AudioSource | null): void {
        this.bgmSource = src ?? undefined;
        if (this.bgmSource) this.bgmSource.volume = this.musicVol / 100;
    }

    /** 预加载 BGM 音频片段 */
    loadClips(bgmPath = 'music/KoiKouEnishi'): Promise<void> {
        return new Promise((resolve) => {
            resources.load(bgmPath, AudioClip, (err, clip) => {
                if (!err && clip) this.bgmClip = clip;
                resolve();
            });
        });
    }

    /** 预加载命中音效（资源可选，缺失则静默） */
    loadSfx(sfxPath = 'sfx/hit'): Promise<void> {
        return new Promise((resolve) => {
            resources.load(sfxPath, AudioClip, (err, clip) => {
                if (!err && clip) this.sfxClip = clip;
                resolve();
            });
        });
    }

    playBgm(): void {
        if (this.bgmSource && this.bgmClip) {
            this.bgmSource.clip = this.bgmClip;
            this.bgmSource.volume = this.musicVol / 100;
            if (!this.bgmSource.playing) this.bgmSource.play();
        }
    }

    stopBgm(): void {
        if (this.bgmSource && this.bgmSource.playing) this.bgmSource.stop();
    }

    pauseBgm(): void {
        if (this.bgmSource && this.bgmSource.playing) this.bgmSource.pause();
    }

    resumeBgm(): void {
        // AudioSource 没有 resume()（3.8 已废弃）。play() 在已 pause 的源上等同于从中断处继续。
        if (this.bgmSource && !this.bgmSource.playing) this.bgmSource.play();
    }

    setMusicVol(v: number): void {
        this.musicVol = v;
        if (this.bgmSource) this.bgmSource.volume = Math.max(0, Math.min(1, v / 100));
    }

    setSfxVol(v: number): void {
        this.sfxVol = v;
        if (this.sfxSource) this.sfxSource.volume = Math.max(0, Math.min(1, v / 100));
    }

    /** 播放命中音效（若已加载 sfxClip） */
    playHit(): void {
        if (!this.sfxClip) return;
        if (!this.sfxSource) {
            this.sfxSource = this.node.addComponent(AudioSource);
            this.sfxSource.volume = this.sfxVol / 100;
        }
        this.sfxSource.playOneShot(this.sfxClip, this.sfxVol / 100);
    }
}
