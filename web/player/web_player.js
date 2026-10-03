// 视频预览窗口脚本：接收主进程推送的视频信息，使用下载同款的 DASH 音视频流播放，通过传统接口获取弹幕
const $previewTitle = document.getElementById('previewTitle');
const $previewStatus = document.getElementById('previewStatus');

let art = null;
let audioSync = null;

// 音视频同步控制器：管理独立音频流与 ArtPlayer 视频流的精准同步
class DashAudioSynchronizer {
    constructor(artInstance, audioUrl) {
        this.art = artInstance;
        this.video = artInstance.video;
        this.audio = new Audio();
        this.audio.preload = 'auto';
        this.audio.src = audioUrl;

        // 视频轨保持静音，声音全部由独立音频元素播放
        this.video.muted = false;
        this.syncVolume();

        this._bindEvents();
    }

    _bindEvents() {
        const v = this.video;
        const a = this.audio;

        this._onPlay = () => {
            a.play().catch(err => console.warn('音频播放受阻或缓冲中:', err));
        };
        this._onPause = () => {
            a.pause();
        };
        this._onSeeking = () => {
            a.currentTime = v.currentTime;
        };
        this._onSeeked = () => {
            a.currentTime = v.currentTime;
        };
        this._onRateChange = () => {
            a.playbackRate = v.playbackRate;
        };
        this._onWaiting = () => {
            a.pause();
        };
        this._onPlaying = () => {
            if (!v.paused) {
                a.play().catch(() => {});
            }
        };
        this._onTimeUpdate = () => {
            if (!v.paused && a.paused) {
                a.play().catch(() => {});
            }
            const diff = a.currentTime - v.currentTime;
            // 漂移超过 0.15 秒，进行校准
            if (Math.abs(diff) > 0.15) {
                a.currentTime = v.currentTime;
            }
        };

        v.addEventListener('play', this._onPlay);
        v.addEventListener('pause', this._onPause);
        v.addEventListener('seeking', this._onSeeking);
        v.addEventListener('seeked', this._onSeeked);
        v.addEventListener('ratechange', this._onRateChange);
        v.addEventListener('waiting', this._onWaiting);
        v.addEventListener('playing', this._onPlaying);
        v.addEventListener('timeupdate', this._onTimeUpdate);
    }

    syncVolume() {
        if (!this.audio || !this.art) return;
        this.audio.volume = this.art.muted ? 0 : this.art.volume;
        this.audio.muted = this.art.muted;
    }

    destroy() {
        const v = this.video;
        const a = this.audio;
        if (v) {
            v.removeEventListener('play', this._onPlay);
            v.removeEventListener('pause', this._onPause);
            v.removeEventListener('seeking', this._onSeeking);
            v.removeEventListener('seeked', this._onSeeked);
            v.removeEventListener('ratechange', this._onRateChange);
            v.removeEventListener('waiting', this._onWaiting);
            v.removeEventListener('playing', this._onPlaying);
            v.removeEventListener('timeupdate', this._onTimeUpdate);
        }
        if (a) {
            a.pause();
            a.src = '';
            a.load();
        }
        this.audio = null;
        this.video = null;
        this.art = null;
    }
}

function setStatus(message, isError = false) {
    if (!$previewStatus) return;
    $previewStatus.textContent = message || '';
    $previewStatus.classList.toggle('error', !!isError);
    $previewStatus.classList.toggle('hide', !message);
}

async function startPreview(payload = {}) {
    const { bvid, cid, title } = payload;
    if (!bvid || !cid) {
        setStatus('未获取到有效的视频信息', true);
        return;
    }

    $previewTitle.textContent = title || '视频预览';
    document.title = title ? `视频预览 - ${title}` : '视频预览';
    setStatus('正在获取 DASH 视频流与弹幕，请稍候...');

    try {
        const [dashResult, danmuResult] = await Promise.all([
            window.electronAPI.invoke('getPreviewDash', payload),
            window.electronAPI.invoke('getPreviewDanmu', { cid }),
        ]);

        if (!dashResult.success || !dashResult.data) {
            throw new Error(dashResult.message || '获取 DASH 视频流失败');
        }

        const { videoList, defaultVideo, defaultAudioUrl } = dashResult.data;
        if (!defaultVideo || !defaultVideo.url) {
            throw new Error('未找到可用的视频画面流');
        }

        // 通过传统接口获取弹幕 xml 文本，转为 blob url 供弹幕插件解析
        let danmuUrl = '';
        if (danmuResult.success && danmuResult.data) {
            const danmuBlob = new Blob([danmuResult.data], { type: 'text/xml' });
            danmuUrl = URL.createObjectURL(danmuBlob);
        } else {
            console.warn('弹幕获取失败：', danmuResult.message);
        }

        // 清理上一次的播放器和音频同步器
        if (audioSync) {
            audioSync.destroy();
            audioSync = null;
        }
        if (art) {
            art.destroy(false);
            art = null;
        }

        // 构建清晰度切换菜单（同款 DASH 流清晰度列表）
        const qualityOptions = videoList.map((item) => ({
            default: item.url === defaultVideo.url,
            html: item.label,
            url: item.url,
        }));

        art = new Artplayer({
            container: '.preview-player-container',
            url: defaultVideo.url,
            title: title || '',
            autoSize: true,
            fullscreen: true,
            fullscreenWeb: true,
            autoOrientation: true,
            setting: true,
            backdrop: true, // 使用毛玻璃效果
            playbackRate: true,
            screenshot: true,
            autoplay: true,
            theme: '#23ade5',
            quality: qualityOptions.length > 1 ? qualityOptions : [],
            plugins: danmuUrl ? [
                artplayerPluginDanmuku({
                    danmuku: danmuUrl, // 弹幕数据源
                    speed: 7, // 弹幕持续时间，范围在[1 ~ 10]
                    margin: [10, '25%'], // 弹幕上下边距
                    opacity: 1, // 弹幕透明度
                    color: '#FFFFFF', // 默认弹幕颜色
                    mode: 0, // 默认弹幕模式: 0: 滚动，1: 顶部，2: 底部
                    modes: [0, 1, 2], // 弹幕可见的模式
                    fontSize: 25, // 弹幕字体大小
                    antiOverlap: true, // 弹幕防重叠
                    synchronousPlayback: false, // 同步播放速度
                    heatmap: false,
                    width: 512,
                    filter: danmu => danmu.text.length <= 100,
                    visible: true,
                    emitter: false,
                }),
            ] : [],
        });

        // 挂载 DASH 音频同步器
        if (defaultAudioUrl) {
            audioSync = new DashAudioSynchronizer(art, defaultAudioUrl);
        }

        // 监听音量改变并同步至音频流
        art.on('video:volumechange', () => {
            if (audioSync) {
                audioSync.syncVolume();
            }
        });

        // 清晰度切换或重新加载后，保持画面静音并继续由同步器发声
        art.on('video:loadeddata', () => {
            if (art?.video) {
                art.video.muted = true;
            }
        });
        art.on('restart', () => {
            if (art?.video) {
                art.video.muted = true;
            }
        });

        art.on('error', (error) => {
            console.error('播放出错:', error, art?.video?.error);
            const mediaErr = art?.video?.error;
            let errMsg = '视频播放失败，可能是当前编码不被支持或网络超时';
            if (mediaErr) {
                errMsg += ` (错误代码: ${mediaErr.code}${mediaErr.message ? ' - ' + mediaErr.message : ''})`;
            }
            setStatus(errMsg, true);
        });

        art.on('video:canplay', () => setStatus(''));
    } catch (error) {
        console.error('预览加载失败:', error);
        setStatus(error.message || '预览加载失败', true);
    }
}

window.electronAPI.on('previewVideo', (payload) => {
    startPreview(payload);
});

