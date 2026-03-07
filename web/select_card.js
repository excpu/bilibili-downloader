// 视频信息展示和用户选择器
function selectInfo() {
    const $videoInfoSection = document.getElementById('videoInfoSection');
    const $multiPartSelector = document.getElementById('multiPartSelector');
    const $multiPartSelectorInner = document.getElementById("multiPartSelectorInner");
    // 更新视频标题
    function updateTitle(title) {
        const $videoTitle = document.getElementById('videoTitle');
        $videoTitle.textContent = title;
    }
    // 更新视频信息
    function updateMeta(upName) {
        const $videoMeta = document.getElementById('videoMeta');
        $videoMeta.textContent = `UP主: ${upName}`;
    }
    // 展示缩略图
    function updateThumbnail(thumbnailUrl) {
        const $videoThumbnail = document.getElementById('videoThumbnail');
        $videoThumbnail.src = thumbnailUrl;
    }
    // 展示整个信息选择器
    function show() {
        $videoInfoSection.classList.remove('hidden');
    }
    // 隐藏整个信息选择器
    function hide() {
        $videoInfoSection.classList.add('hidden');
    }
    // 隐藏整个信息选择器
    // 在获取信息时禁用确认按钮，防止用户重复点击
    function disableConfirmBtn() {
    }
    // 获取到视频信息后启用确认按钮
    function enableConfirmBtn() {
    }
    // 用于展示清晰度选项和音频选项
    function displayStreamOptions(dash) {
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
        for (let i = 0; i < dash.video.length; i++) {
            $qualitySelect.innerHTML += `<option value="${i}">${qualityIndex[dash.video[i].id] || dash.video[i].id} - ${codecIndex[dash.video[i].codecs.split('.')[0]] || dash.video[i].codecs}</option>`;
        }
        const $qualitySelectAudio = document.getElementById('qualitySelectAudio');
        $qualitySelectAudio.innerHTML = ''; // 清空之前的选项
        for (let i = 0; i < dash.audio.length; i++) {
            $qualitySelectAudio.innerHTML += `<option value="${dash.audio[i].id}">${audioIndex[dash.audio[i].id] || dash.audio[i].id} - ${dash.audio[i].codecs.split('.')[0].toUpperCase()}</option>`;
            if (bestAudio < dash.audio[i].id) {
                bestAudio = dash.audio[i].id;
            }
        }

        // 处理FLAC无损
        if (dash.flac !== null) {
            $qualitySelectAudio.innerHTML += `<option value="${dash.flac.audio.id}">FLAC  无损</option>`;
        }

        // 处理杜比全景声
        if (dash.dolby.audio !== null) {
            $qualitySelectAudio.innerHTML += `<option value="${dash.dolby.audio[0].id}">杜比全景声</option>`;
        }

        // 默认选择最高质量音频 (有损)
        try {
            $qualitySelectAudio.value = String(bestAudio);
        } catch (e) {
            console.log('默认最高音质选择错误');
        }
    }

    // 显示分P选择器
    function showMultipartSelector() {
        $multiPartSelector.classList.remove('hidden');

    }

    // 隐藏分P选择器
    function hideMultipartSelector() {
        $multiPartSelector.classList.add('hidden');
    }

    function addMultipart(pages) {
        let counter = 0;
        for (let i of pages) {
            $multiPartSelectorInner.innerHTML += `<label><input class="p-item" type="checkbox" name="part[]" value="${counter}">P${i.page} - ${i.part}</label>`;
            counter++;
        }
    }

    function clearMultipart() {
        $multiPartSelectorInner.innerHTML = '';
    }


    return {
        updateTitle,
        disableConfirmBtn,
        enableConfirmBtn,
        showMultipartSelector,
        addMultipart,
        clearMultipart,
        updateMeta,
        updateThumbnail,
        displayStreamOptions,
        show,
        hide,
        hideMultipartSelector
    }
}