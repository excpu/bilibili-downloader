const $urlInput = document.getElementById('urlInput');
const $confirmBtn = document.getElementById('confirmBtn');
const $tasksContainer = document.getElementById('tasksContainer');
const $avatar = document.getElementById('avatar');
const $loginSection = document.getElementById('loginSection');
const $cancelLoginBtn = document.getElementById('cancelLogin');
const $videoInfoSection = document.getElementById('videoInfoSection');
const $cancelVideoInfo = document.getElementById('cancelVideoInfo');
const downloadBtn = document.getElementById('downloadBtn');

let globalLoginStatus = false;

let globalName = '';

// 用户防止在没有正常更新数据时下载旧视频
let downloadLock = false;

// 回车开始下载
$urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        getVideoInfo();
    }
});

// 点击按钮开始下载
$confirmBtn.addEventListener('click', () => {
    downloadLock = true;
    getVideoInfo();
});

// 开始查询视频信息
function getVideoInfo() {
    const url = $urlInput.value.trim();
    // URL判空
    if (!url) {
        return;
    }
    // 提取BV号
    const bv = extractBV(url);
    if (!bv) {
        alert('请输入有效的B站视频链接或BV号');
        return;
    }
    $videoInfoSection.classList.remove('hidden');
    // 获取视频基本信息
    window.electronAPI.invoke('getVideoInfo', bv).then((videoInfo) => {
        console.log('获取到视频信息:', videoInfo);
        // 检查是否分P视频
        if (videoInfo.data.videos > 1) {
            $videoInfoSection.classList.add('hidden');
            alert('当前版本仅支持单P视频下载，敬请期待后续更新！');
            return;
        }
        // 有些视频会需要跳转
        if (videoInfo.data.need_jump_bv) {
            $videoInfoSection.classList.add('hidden');
            alert('该视频需要跳转，当前版本暂不支持此类视频的下载。');
            return;
        }
        const $videoTitle = document.getElementById('videoTitle');
        $videoTitle.textContent = videoInfo.data.title;
        globalName = videoInfo.data.title;
        const $videoMeta = document.getElementById('videoMeta');
        $videoMeta.textContent = `UP主: ${videoInfo.data.owner.name}`;
        const $videoThumbnail = document.getElementById('videoThumbnail');
        $videoThumbnail.src = videoInfo.data.pic;

        getVideoStreams(bv, videoInfo.data.cid, videoInfo.data.title);

    });
}

let currentVideoIdentity = null;
function getVideoStreams(bvid, cid, title) {
    console.log('视频CID:', cid);
    window.electronAPI.invoke('getVideoStreams', { bvid, cid }).then((streamInfo) => {
        console.log('获取到视频流信息:', streamInfo);
        currentVideoIdentity = { bvid, cid, title };
        const qualityIndex = {
            6: "240P 极速",
            16: "360P 流畅",
            32: "480P 清晰",
            64: "720P 标清",
            74: "720P60 高帧率",
            80: "1080P 高清",
            112: "1080P+ 高码率",
            116: "1080P60 高帧率",
            120: "超清 4K",
            125: "HDR 真彩色",
            126: "杜比视界",
            127: "8K 超高清",
            129: "HDR Vivid",
        };
        const audioIndex = {
            30216: "64K",
            30232: "132K",
            30280: "192K",
            30250: "杜比全景声",
            30251: "Hi-Res无损"
        };
        const codecIndex = {
            avc1: "H.264 AVC 编码",
            hev1: "H.265 HEVC 编码",
            av01: "AV1 编码"
        };
        let bestAudio = 0;
        const $qualitySelect = document.getElementById('qualitySelect');
        $qualitySelect.innerHTML = ''; // 清空之前的选项
        for (let i = 0; i < streamInfo.data.dash.video.length; i++) {
            $qualitySelect.innerHTML += `<option value="${i}">${qualityIndex[streamInfo.data.dash.video[i].id] || streamInfo.data.dash.video[i].id} - ${codecIndex[streamInfo.data.dash.video[i].codecs.split('.')[0]] || streamInfo.data.dash.video[i].codecs}</option>`;
        }
        const $qualitySelectAudio = document.getElementById('qualitySelectAudio');
        $qualitySelectAudio.innerHTML = ''; // 清空之前的选项
        for (let i = 0; i < streamInfo.data.dash.audio.length; i++) {
            $qualitySelectAudio.innerHTML += `<option value="${streamInfo.data.dash.audio[i].id}">${audioIndex[streamInfo.data.dash.audio[i].id] || streamInfo.data.dash.audio[i].id} - ${streamInfo.data.dash.audio[i].codecs.split('.')[0].toUpperCase()}</option>`;
            if (bestAudio < streamInfo.data.dash.audio[i].id) {
                bestAudio = streamInfo.data.dash.audio[i].id;
            }
        }
        // 默认选择最高质量音频
        try {
            $qualitySelectAudio.value = String(bestAudio);
        } catch (e) {
            console.log('默认最高音质选择错误');
        }

        downloadLock = false;

    });
}


// 用户点击确认开始下载
downloadBtn.addEventListener('click', async () => {
    if (!downloadLock) {
        manageDownloadStart();
    }
});


// 提取连接中BV号
function extractBV(url) {
    const bvMatch = url.match(/BV[0-9A-Za-z]+/);
    return bvMatch ? bvMatch[0] : null;
}

// 用户取消下载
$cancelVideoInfo.addEventListener('click', () => {
    console.log('用户取消下载视频信息展示');
    $videoInfoSection.classList.add('hidden');
});

// 启动时获取登录状态
window.electronAPI.invoke('loginStatus').then((status) => {
    console.log('登录状态:', status);
    if (status) {
        fetchUserInfo();
    }
});


// 若登录，获取用户信息
function fetchUserInfo() {
    window.electronAPI.invoke('getUserInfo').then((userInfo) => {
        console.log('用户信息:', userInfo);
        globalLoginStatus = true;
        $avatar.innerHTML = `<img src="${userInfo.data.face}" alt="用户头像" class="avatar-img">`;
    });
}

// 点击头像区域触发登录
$avatar.addEventListener('click', () => {
    console.log('点击了头像区域，触发登录流程');
    if (globalLoginStatus) {
        console.log('用户已登录，无需重复登录');
        return;
    }
    $loginSection.classList.remove('hidden');
    requestLoginQr();
});

// 用户取消登录
$cancelLoginBtn.addEventListener('click', () => {
    console.log('用户取消登录');
    $loginSection.classList.add('hidden');
    // 停止轮询
    if (pollInterval) {
        clearInterval(pollInterval);
    }
});

var pollInterval = null;

// 请求登录二维码
function requestLoginQr() {
    window.electronAPI.invoke('requestLoginQr').then((response) => {
        if (response.success) {
            const qrData = response.data.url;
            console.log('收到登录二维码数据:', response);
            // 生成二维码图片
            const $loginQr = document.getElementById('loginQr');
            $loginQr.innerHTML = ''; // 清空之前的二维码
            showQr($loginQr, qrData);
            // 轮询登录状态
            pollInterval = setInterval(() => {
                window.electronAPI.invoke('pollQrLoginStatus', response.data.qrcode_key).then((statusResponse) => {
                    if (statusResponse.success) {
                        console.log('登录成功:', statusResponse);
                        clearInterval(pollInterval);
                        $loginSection.classList.add('hidden');
                        fetchUserInfo();
                        globalLoginStatus = true;
                    } else if (statusResponse.message === '二维码过期') {
                        console.log('二维码过期');
                        clearInterval(pollInterval);
                    } else {
                        console.log('登录未完成，继续轮询...');
                    }
                });
            }, 3000); // 每3秒轮询一次
        } else {
            console.error('请求登录二维码失败:', response.message);
        }
    });
}

// 生成QR
function showQr(element, url) {
    new QRCode(element, {
        text: url,
        width: 200,
        height: 200
    });
}

// 刷新登录二维码
document.getElementById('refreshLoginQr').addEventListener('click', () => {
    console.log('刷新登录二维码');
    requestLoginQr();
});



