// DOM
const $urlInput = document.getElementById('urlInput');
const $confirmBtn = document.getElementById('confirmBtn');
const $tasksContainer = document.getElementById('tasksContainer');
const $avatar = document.getElementById('avatar');
const $loginSection = document.getElementById('loginSection');
const $cancelLoginBtn = document.getElementById('cancelLogin');
const $cancelVideoInfo = document.getElementById('cancelVideoInfo');
const $downloadBtn = document.getElementById('downloadBtn');

// 全局登录状态
let globalLoginStatus = false;

let multiPartVideo = false;

// 视频信息展示和用户选择器
const infoSection = selectInfo();
// BV 编码函数
const av2bv = bvEnc();

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
    return window.electronAPI.invoke('getVideoInfo', bv).then(async (videoInfo) => {
        if (!videoInfo.success) {
            alert('获取视频信息失败：' + videoInfo.message);
            downloadLock = false;
            infoSection.hide();
            return;
        }
        console.log('获取到视频信息:', videoInfo);
        // 有些视频会需要跳转
        if (videoInfo.data.need_jump_bv) {
            downloadLock = false;
            infoSection.hide();
            alert('该视频需要跳转，当前版本暂不支持此类视频的下载。');
            return;
        }
        // 隐藏合集搜索按钮
        infoSection.hideCollectionSearch();
        // 更新UI显示视频信息
        infoSection.updateTitle(videoInfo.data.title);
        // 更新UP主信息
        infoSection.updateMeta(videoInfo.data.owner.name);
        // 更新缩略图（等待封面加载完成，与其他内容一起显示）
        const thumbnailTask = infoSection.updateThumbnail(videoInfo.data.pic);
        // 判断视频是否有合集，若有合集显示合集搜索按钮
        infoSection.collectionSearch(videoInfo.data);
        // 清空之前的分P选项
        infoSection.clearMultipart();
        // 检查是否分P视频
        if (videoInfo.data.videos > 1) {
            //现已支持分P视频下载,展示分P选择器
            infoSection.showMultipartSelector();
            // 列出分P
            infoSection.addMultipart(videoInfo.data.pages);
            multiPartVideo = true;
        } else {
            // 非分P隐藏分P选择器
            infoSection.hideMultipartSelector();
            multiPartVideo = false;
        }
        // 获取视频流信息时传入分P信息
        const streamTask = getVideoStreams(
            bv,
            videoInfo.data.cid,
            videoInfo.data.title,
            multiPartVideo ? videoInfo.data.pages : [],
            videoInfo.data.pic,
            videoInfo.data.duration
        );
        // 等封面、画质/音频、字幕全部就绪后再一次性显示，避免内容分几次跳出来
        await Promise.all([thumbnailTask, streamTask]);
        infoSection.reveal();
    }).catch((error) => {
        console.error('获取视频信息失败:', error);
        downloadLock = false;
        alert(`获取视频信息失败：${error?.message || '未知错误'}`);
        infoSection.hide();
    });
}

let currentVideoIdentity = null;

function buildCollectionParts(episodes) {
    return episodes.flatMap(episode => episode.pages.map(page => ({
        selectionId: `${episode.episode}:${page.page}`,
        episode: episode.episode,
        episodeTitle: episode.title,
        pageCount: episode.pages.length,
        page: page.page,
        part: page.part,
        bvid: page.bvid,
        aid: page.aid,
        cid: page.cid,
        duration: page.duration,
        coverUrl: page.coverUrl
    })));
}

// 处理合集数据
window.addEventListener('season-data-loaded', (event) => {
    const detail = event.detail || {};
    const seasonData = detail.seasonData || {};
    const sourceVideo = detail.sourceVideo || {};
    const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];

    if (episodes.length < 1) {
        return;
    }

    const seasonTitle = seasonData.meta?.title || seasonData.meta?.name || sourceVideo.title || '合集';
    const seasonCover = seasonData.meta?.cover || sourceVideo.pic;

    currentVideoIdentity = {
        bvid: sourceVideo.bvid,
        cid: null,
        title: seasonTitle,
        subtitleBvid: sourceVideo.bvid,
        subtitleCid: sourceVideo.pages?.[0]?.cid || sourceVideo.cid,
        subtitleTitle: sourceVideo.pages?.length > 1
            ? `P${sourceVideo.pages[0].page} - ${sourceVideo.title} - ${sourceVideo.pages[0].part}`
            : sourceVideo.title || seasonTitle,
        p: buildCollectionParts(episodes),
        danmu: false,
        coverUrl: seasonCover,
        duration: 0,
        isCollection: true
    };

    infoSection.updateTitle(seasonTitle);
    infoSection.updateThumbnail(seasonCover);
});

window.addEventListener('collection-episode-details-loaded', (event) => {
    if (!currentVideoIdentity?.isCollection) {
        return;
    }
    currentVideoIdentity.p = buildCollectionParts(event.detail?.episodes || []);
});

function getVideoStreams(bvid, cid, title, p = [], coverUrl, duration) {
    console.log('视频CID:', cid);
    const subtitlePage = p[0];
    const subtitleBvid = subtitlePage?.bvid || bvid;
    const subtitleCid = subtitlePage?.cid || cid;
    currentVideoIdentity = {
        bvid,
        cid,
        title,
        subtitleBvid,
        subtitleCid,
        subtitleTitle: p.length > 1
            ? `P${p[0].page} - ${title} - ${p[0].part}`
            : title,
        p,
        danmu: false,
        coverUrl,
        duration
    };
    return (async () => {
        let streamInfo;
        try {
            streamInfo = await window.electronAPI.invoke('getVideoStreams', { bvid, cid });
        } catch (error) {
            streamInfo = { success: false, message: error?.message };
        }
        console.log('获取到视频流信息:', streamInfo);
        if (!streamInfo?.success || !streamInfo.data?.dash) {
            alert(`获取视频流信息失败：${streamInfo?.message || '未知错误'}`);
            // 没有画质信息时不允许下载，保留 downloadLock 让“确认下载”失效
            return;
        }
        // 渲染音频流和视频流
        infoSection.displayStreamOptions(streamInfo.data.dash);
        downloadLock = false;

        // 字幕列表同样属于详情内容，等它渲染完再统一显示
        await infoSection.getSubtitleInfo(subtitleBvid, subtitleCid).catch((error) => {
            console.error('获取字幕信息失败:', error);
            alert(`获取字幕信息失败：${error.message}`);
        });
    })();
}

const $downloadSelectedSubtitleBtn = document.getElementById('downloadSelectedSubtitleBtn');
$downloadSelectedSubtitleBtn.addEventListener('click', async () => {
    const subtitleLanguage = document.getElementById('qualitySelectSubtitle').value;
    if (!subtitleLanguage) {
        model.showInfoMessage('请先选择要下载的字幕');
        return;
    }
    if (!currentVideoIdentity?.subtitleBvid || !currentVideoIdentity?.subtitleCid) {
        model.showErrorMessage('视频字幕信息尚未加载完成');
        return;
    }

    const subtitleIdentity = {
        bvid: currentVideoIdentity.subtitleBvid,
        cid: currentVideoIdentity.subtitleCid,
        title: currentVideoIdentity.subtitleTitle || currentVideoIdentity.title
    };
    $downloadSelectedSubtitleBtn.disabled = true;
    try {
        const playerConfig = await window.electronAPI.invoke(
            'getPlayerConfig',
            subtitleIdentity.bvid,
            subtitleIdentity.cid
        );
        if (!playerConfig?.success) {
            throw new Error(playerConfig?.message || '获取字幕信息失败');
        }

        const subtitles = playerConfig.data?.data?.subtitle?.subtitles || [];
        const subtitle = subtitles.find((item, index) =>
            String(item.lan || item.id || index) === subtitleLanguage
        );
        if (!subtitle?.subtitle_url) {
            throw new Error(subtitle ? '字幕地址缺失' : '当前视频没有匹配的字幕');
        }

        const result = await window.electronAPI.invoke('downloadSubtitle', {
            subtitleUrl: subtitle.subtitle_url,
            language: subtitle.lan || subtitleLanguage,
            title: subtitleIdentity.title,
            folderNames: await folderStructure.forIdentity(
                currentVideoIdentity,
                subtitleIdentity.cid
            )
        });
        if (!result?.success) {
            throw new Error(result?.message || '未知错误');
        }
        model.showSuccessMessage('字幕下载完成');
    } catch (error) {
        model.showErrorMessage(`字幕下载失败：${error.message || '未知错误'}`);
    } finally {
        $downloadSelectedSubtitleBtn.disabled = false;
    }
});


// 点击封面预览当前视频：弹出独立窗口，通过传统接口获取弹幕并预览，通过视频直链播放
// 封面上已有悬浮播放按钮样式（.thumbnail-inner），此处为其绑定预览行为
const $videoThumbnailInner = document.querySelector('.video-info .thumbnail-inner');
if ($videoThumbnailInner) {
    $videoThumbnailInner.title = '点击预览视频';
    $videoThumbnailInner.addEventListener('click', () => {
        if (!currentVideoIdentity?.bvid) {
            return;
        }
        // 合集/分P场景优先使用当前已加载的第一个分 P 的 cid
        const cid = currentVideoIdentity.cid || currentVideoIdentity.p?.[0]?.cid;
        if (!cid) {
            alert('视频信息尚未加载完成，无法预览');
            return;
        }
        const $qualitySelect = document.getElementById('qualitySelect');
        const $qualitySelectAudio = document.getElementById('qualitySelectAudio');
        const selectedVideoOption = $qualitySelect?.options?.[$qualitySelect.selectedIndex];
        const selectedAudioOption = $qualitySelectAudio?.options?.[$qualitySelectAudio.selectedIndex];

        window.electronAPI.invoke('openPreviewWindow', {
            bvid: currentVideoIdentity.bvid,
            cid,
            title: currentVideoIdentity.title,
            videoQualityId: selectedVideoOption?.dataset?.qualityId,
            videoCodec: selectedVideoOption?.dataset?.codec,
            audioQualityId: selectedAudioOption?.dataset?.qualityId,
            audioCodec: selectedAudioOption?.dataset?.codec,
        });
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
        return av2bv(avMatch[1]);
    }

    // 3. 纯数字 (认为是 avid)
    const numMatch = input.match(/^\d+$/);
    if (numMatch) {
        return av2bv(numMatch[0]);
    }

    return null;
}

// 用户取消下载
$cancelVideoInfo.addEventListener('click', () => {
    console.log('用户取消下载视频信息展示');
    infoSection.hide();
});

let globalUserInfo = null;

// 登录状态未知时，头像显示转圈动画，避免先闪一下“登录”再变成头像
let avatarLoadingTimeout = null;

// 启动时获取登录状态（头像先播放加载动画，状态返回后再切换）
setAvatarLoading();
window.electronAPI.invoke('loginStatus').then((status) => {
    console.log('登录状态:', status);
    if (status) {
        fetchUserInfo();
    } else {
        renderLoggedOut();
    }
}).catch((error) => {
    console.error('获取登录状态失败:', error);
    renderLoggedOut();
});

function setAvatarLoading() {
    $avatar.classList.add('is-loading');
    $avatar.setAttribute('aria-busy', 'true');
    $avatar.title = '正在获取登录状态';
    $avatar.innerHTML = '<span class="micon-spin avatar-spinner" aria-hidden="true"></span>';
    if (avatarLoadingTimeout) {
        clearTimeout(avatarLoadingTimeout);
    }
    // 兜底：状态迟迟不返回时按未登录展示，避免一直转圈
    avatarLoadingTimeout = setTimeout(() => {
        console.warn('获取登录状态超时，暂按未登录展示');
        renderLoggedOut();
    }, 8000);
}

function clearAvatarLoading() {
    if (avatarLoadingTimeout) {
        clearTimeout(avatarLoadingTimeout);
        avatarLoadingTimeout = null;
    }
    $avatar.classList.remove('is-loading');
    $avatar.removeAttribute('aria-busy');
    $avatar.removeAttribute('title');
}

function renderLoggedIn(userInfo) {
    clearAvatarLoading();
    globalUserInfo = userInfo;
    globalLoginStatus = true;
    $avatar.innerHTML = `<img src="${userInfo.data.face}" alt="用户头像" class="avatar-img">`;
}

function renderLoggedOut() {
    clearAvatarLoading();
    globalUserInfo = null;
    globalLoginStatus = false;
    $avatar.textContent = '登录';
}

window.syncLoginState = {
    loggedIn: renderLoggedIn,
    loggedOut: renderLoggedOut,
};

// 若登录，获取用户信息
function fetchUserInfo() {
    window.electronAPI.invoke('getUserInfo').then((userInfo) => {
        //console.log('用户信息:', userInfo);
        if (userInfo.data.isLogin) {
            renderLoggedIn(userInfo);
        } else {
            renderLoggedOut();
        }
    }).catch((error) => {
        console.error('获取用户信息失败:', error);
        renderLoggedOut();
    });
}

// 点击头像区域触发登录
$avatar.addEventListener('click', () => {
    console.log('点击了头像区域，触发登录流程');
    // 登录状态还在获取中，先忽略点击，避免误弹登录框
    if ($avatar.classList.contains('is-loading')) {
        console.log('登录状态获取中，暂不处理点击');
        return;
    }
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
