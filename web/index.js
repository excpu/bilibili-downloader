// DOM
const $urlInput = document.getElementById('urlInput');
const $confirmBtn = document.getElementById('confirmBtn');
const $tasksContainer = document.getElementById('tasksContainer');
const $avatar = document.getElementById('avatar');
const $loginSection = document.getElementById('loginSection');
const $cancelLoginBtn = document.getElementById('cancelLogin');
const $cancelVideoInfo = document.getElementById('cancelVideoInfo');
const $downloadBtn = document.getElementById('downloadBtn');

let globalLoginStatus = false;

let multiPartVideo = false;

// 视频信息展示和用户选择器
const infoSection = selectInfo();

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
    infoSection.show();
    // 自动清空URL
    $urlInput.value = "";
    // 获取视频基本信息
    window.electronAPI.invoke('getVideoInfo', bv).then((videoInfo) => {
        if (!videoInfo.success) {
            alert('获取视频信息失败：' + videoInfo.message);
            infoSection.hide();
            return;
        }
        console.log('获取到视频信息:', videoInfo);
        // 有些视频会需要跳转
        if (videoInfo.data.need_jump_bv) {
            infoSection.hide();
            alert('该视频需要跳转，当前版本暂不支持此类视频的下载。');
            return;
        }
        // 更新UI显示视频信息
        infoSection.updateTitle(videoInfo.data.title);
        // 更新UP主信息
        infoSection.updateMeta(videoInfo.data.owner.name);
        // 更新缩略图
        infoSection.updateThumbnail(videoInfo.data.pic);
        // 清空之前的分P选项
        infoSection.clearMultipart();
        // 检查是否分P视频
        if (videoInfo.data.videos > 1) {
            //现已支持分P视频下载,展示分P选择器
            infoSection.showMultipartSelector();
            // 列出分P
            infoSection.addMultipart(videoInfo.data.pages);

            // 获取视频流信息时传入分P信息
            getVideoStreams(bv, videoInfo.data.cid, videoInfo.data.title, videoInfo.data.pages);
            multiPartVideo = true;
        } else {
            // 非分P隐藏分P选择器，直接获取视频流信息
            infoSection.hideMultipartSelector();
            getVideoStreams(bv, videoInfo.data.cid, videoInfo.data.title);
            multiPartVideo = false;
        }
    });
}

let currentVideoIdentity = null;
function getVideoStreams(bvid, cid, title, p = []) {
    console.log('视频CID:', cid);
    window.electronAPI.invoke('getVideoStreams', { bvid, cid }).then((streamInfo) => {
        console.log('获取到视频流信息:', streamInfo);
        currentVideoIdentity = { bvid, cid, title, p, danmu: false };
        // 渲染音频流和视频流
        infoSection.displayStreamOptions(streamInfo.data.dash);
        downloadLock = false;

    });
}


// 用户点击确认开始下载
$downloadBtn.addEventListener('click', async () => {
    if (!downloadLock) {
        // 见download_task.js
        manageDownloadStart();
    }
});


// 提取连接中BV号
function extractBV(input) {
    // 1. 先匹配 BV 号
    const bvMatch = input.match(/BV[0-9A-Za-z]+/);
    if (bvMatch) {
        return bvMatch[0];
    }

    // 2. 匹配 av 号 (例如 av123456)
    const avMatch = input.match(/av(\d+)/i);
    if (avMatch) {
        return bvenc(avMatch[1]);
    }

    // 3. 纯数字 (认为是 avid)
    const numMatch = input.match(/^\d+$/);
    if (numMatch) {
        return bvenc(numMatch[0]);
    }

    return null;
}

// 用户取消下载
$cancelVideoInfo.addEventListener('click', () => {
    console.log('用户取消下载视频信息展示');
    infoSection.hide();
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



