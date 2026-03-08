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
        if (thumbnailUrl.startsWith("https:") || thumbnailUrl.startsWith("http:")) {
            $videoThumbnail.src = thumbnailUrl;
        }
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

        // 插入视频选项
        let fragment = document.createDocumentFragment();
        for (let i = 0; i < dash.video.length; i++) {
            const option = document.createElement("option");

            option.value = i;

            const id = qualityIndex[dash.video[i].id] || dash.video[i].id;
            const codec =
                codecIndex[dash.video[i].codecs.split(".")[0]] || dash.video[i].codecs;

            option.textContent = `${id} - ${codec}`;

            fragment.appendChild(option);
        }
        $qualitySelect.appendChild(fragment);

        const $qualitySelectAudio = document.getElementById('qualitySelectAudio');
        $qualitySelectAudio.innerHTML = ''; // 清空之前的选项

        // 插入音频选项
        fragment = document.createDocumentFragment();
        for (let i = 0; i < dash.audio.length; i++) {
            const audio = dash.audio[i];

            const option = document.createElement("option");

            option.value = audio.id;

            const label = audioIndex[audio.id] || audio.id;
            const codec = audio.codecs.split(".")[0].toUpperCase();

            option.textContent = `${label} - ${codec}`;

            fragment.appendChild(option);

            if (bestAudio < audio.id) {
                bestAudio = audio.id;
            }
        }

        $qualitySelectAudio.appendChild(fragment);

        // 处理 FLAC 无损
        if (dash.flac !== null) {
            const option = document.createElement("option");

            option.value = dash.flac.audio.id;
            option.textContent = "FLAC  无损";

            $qualitySelectAudio.appendChild(option);
        }

        // 处理杜比全景声
        if (dash.dolby.audio !== null) {
            const option = document.createElement("option");

            option.value = dash.dolby.audio[0].id;
            option.textContent = "杜比全景声";

            $qualitySelectAudio.appendChild(option);
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

    // 显示分P视频的每一P的标题和选择框
    function addMultipart(pages) {
        let counter = 0;

        const fragment = document.createDocumentFragment();

        for (const i of pages) {
            const label = document.createElement("label");

            const checkbox = document.createElement("input");
            checkbox.className = "p-item";
            checkbox.type = "checkbox";
            checkbox.name = "part[]";
            checkbox.value = counter;

            label.appendChild(checkbox);

            const text = document.createTextNode(`P${i.page} - ${i.part}`);
            label.appendChild(text);

            fragment.appendChild(label);

            counter++;
        }

        $multiPartSelectorInner.appendChild(fragment);
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