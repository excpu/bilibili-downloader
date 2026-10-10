// 视频信息展示和用户选择器
// infosection
function selectInfo() {
    const $videoInfoSection = document.getElementById('videoInfoSection');
    const $multiPartSelector = document.getElementById('multiPartSelector');
    const $multiPartSelectorInner = document.getElementById("multiPartSelectorInner");
    const $searchAllCollectionDetails = document.getElementById('searchAllCollectionDetails');
    let activeCollectionEpisodes = [];
    let activeDetailRequests = 0;
    const detailRequestQueue = [];

    function runWithDetailLimit(request) {
        return new Promise((resolve, reject) => {
            const run = () => {
                activeDetailRequests++;
                Promise.resolve()
                    .then(request)
                    .then(resolve, reject)
                    .finally(() => {
                        activeDetailRequests--;
                        detailRequestQueue.shift()?.();
                    });
            };

            if (activeDetailRequests < 2) {
                run();
            } else {
                detailRequestQueue.push(run);
            }
        });
    }

    function ensureEpisodeDetails(episode) {
        if (episode.detailsLoaded) {
            return Promise.resolve(episode.pages);
        }
        if (episode.loadingPromise) {
            return episode.loadingPromise;
        }

        episode.loadingPromise = runWithDetailLimit(async () => {
            const result = await window.electronAPI.invoke('getVideoInfo', episode.bvid);
            if (!result?.success || !result.data) {
                throw new Error(result?.message || '获取视频信息失败');
            }
            return result.data;
        }).then(videoData => {
            const sourcePages = Array.isArray(videoData.pages) && videoData.pages.length > 0
                ? videoData.pages
                : [{
                    page: 1,
                    part: episode.title,
                    cid: episode.archive.cid || videoData.cid,
                    duration: episode.duration
                }];
            episode.pages = sourcePages.map((page, pageIndex) => ({
                page: Number(page.page) || pageIndex + 1,
                part: page.part || episode.title,
                bvid: episode.bvid,
                aid: episode.aid,
                cid: page.cid || (sourcePages.length === 1 ? episode.archive.cid || videoData.cid : null),
                duration: Number(page.duration) || episode.duration,
                coverUrl: episode.coverUrl
            }));
            episode.detailsLoaded = true;

            if (activeCollectionEpisodes.includes(episode)) {
                window.dispatchEvent(new CustomEvent('collection-episode-details-loaded', {
                    detail: { episodes: activeCollectionEpisodes }
                }));
            }
            return episode.pages;
        }).catch(error => {
            episode.detailsError = error;
            throw error;
        }).finally(() => {
            episode.loadingPromise = null;
        });

        return episode.loadingPromise;
    }
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
            hvc1: "H.265 HEVC 编码",
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
            option.dataset.qualityId = String(dash.video[i].id);
            option.dataset.codec = (dash.video[i].codecs || '').split(".")[0] || '';

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
            option.dataset.qualityId = String(audio.id);
            option.dataset.codec = (audio.codecs || '').split(".")[0] || '';

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
            option.dataset.qualityId = String(dash.flac.audio.id);
            option.dataset.codec = (dash.flac.audio.codecs || '').split(".")[0] || '';
            option.textContent = "FLAC  无损";

            $qualitySelectAudio.appendChild(option);
        }

        // 处理杜比全景声
        if (dash.dolby.audio !== null) {
            const option = document.createElement("option");

            option.value = dash.dolby.audio[0].id;
            option.dataset.qualityId = String(dash.dolby.audio[0].id);
            option.dataset.codec = (dash.dolby.audio[0].codecs || '').split(".")[0] || '';
            option.textContent = "杜比全景声";

            $qualitySelectAudio.appendChild(option);
        }

        // 默认选择最高质量音频 (有损)
        try {
            $qualitySelectAudio.value = String(bestAudio);
        } catch (e) {
            console.log('默认最高音质选择错误');
        }

        // 插入选择不下载视频的选项
        const noVideoOption = document.createElement("option");
        noVideoOption.value = "-1";
        noVideoOption.dataset.qualityId = "-1";
        noVideoOption.dataset.codec = "";
        noVideoOption.textContent = "无视频";
        $qualitySelect.appendChild(noVideoOption);
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

    function addCollection(episodes) {
        const fragment = document.createDocumentFragment();

        for (const episode of episodes) {
            const episodeElement = document.createElement('div');
            episodeElement.className = 'collection-episode';

            const episodeHeading = document.createElement('div');
            episodeHeading.className = 'collection-episode-heading';

            const episodeCheckbox = document.createElement('input');
            episodeCheckbox.className = 'e-item';
            episodeCheckbox.type = 'checkbox';
            episodeCheckbox.addEventListener('change', () => {
                episode.selectAllRequested = episodeCheckbox.checked;
                if (!episodeCheckbox.checked) {
                    episodeElement.querySelectorAll('.p-item').forEach(box => box.checked = false);
                    episodeCheckbox.indeterminate = false;
                    return;
                }

                setEpisodeExpanded(true).then(loaded => {
                    if (loaded && episode.selectAllRequested) {
                        episodeElement.querySelectorAll('.p-item').forEach(box => box.checked = true);
                        syncEpisodeCheckbox();
                    }
                });
            });

            const episodeTitle = document.createElement('span');
            episodeTitle.textContent = `E${episode.episode} - ${episode.title}`;
            episodeTitle.className = 'collection-episode-title';

            const toggleButton = document.createElement('button');
            toggleButton.type = 'button';
            toggleButton.className = 'btn small collection-toggle';
            toggleButton.textContent = '+';
            toggleButton.setAttribute('aria-expanded', 'false');

            episodeHeading.append(episodeCheckbox, episodeTitle, toggleButton);

            const partsElement = document.createElement('div');
            partsElement.className = 'collection-parts hidden';

            function syncEpisodeCheckbox() {
                const selectedCount = episodeElement.querySelectorAll('.p-item:checked').length;
                const partCount = episodeElement.querySelectorAll('.p-item').length;
                episodeCheckbox.checked = partCount > 0 && selectedCount === partCount;
                episodeCheckbox.indeterminate = selectedCount > 0 && selectedCount < partCount;
            }

            function renderEpisodeParts() {
                partsElement.replaceChildren();
                for (const part of episode.pages) {
                    const partLabel = document.createElement('label');
                    partLabel.className = 'collection-part';

                    const partCheckbox = document.createElement('input');
                    partCheckbox.className = 'p-item';
                    partCheckbox.type = 'checkbox';
                    partCheckbox.name = 'part[]';
                    partCheckbox.value = `${episode.episode}:${part.page}`;
                    partCheckbox.addEventListener('change', syncEpisodeCheckbox);
                    partLabel.append(partCheckbox, document.createTextNode(`P${part.page} - ${part.part}`));
                    partsElement.appendChild(partLabel);
                }
                episode.partsRendered = true;
                if (episode.selectAllRequested) {
                    partsElement.querySelectorAll('.p-item').forEach(box => box.checked = true);
                }
                syncEpisodeCheckbox();
            }

            async function setEpisodeExpanded(expanded) {
                partsElement.classList.toggle('hidden', !expanded);
                toggleButton.textContent = expanded ? '-' : '+';
                toggleButton.setAttribute('aria-expanded', String(expanded));
                if (!expanded) {
                    return false;
                }
                if (episode.detailsLoaded) {
                    if (!episode.partsRendered) {
                        renderEpisodeParts();
                    }
                    return true;
                }

                partsElement.textContent = '正在获取分P详情...';
                try {
                    await ensureEpisodeDetails(episode);
                    renderEpisodeParts();
                    return true;
                } catch (error) {
                    partsElement.textContent = `获取失败：${error.message}，收起后重新展开可重试`;
                    return false;
                }
            }
            // 批量搜索后展开每个分P
            episode.expandAfterBulkSearch = () => {
                partsElement.classList.remove('hidden');
                toggleButton.textContent = '-';
                toggleButton.setAttribute('aria-expanded', 'true');
                if (episode.detailsLoaded) {
                    renderEpisodeParts();
                } else {
                    partsElement.textContent = `获取失败：${episode.detailsError?.message || '详情不可用'}，收起后重新展开可重试`;
                }
            };

            toggleButton.addEventListener('click', () => {
                setEpisodeExpanded(partsElement.classList.contains('hidden'));
            });

            episodeElement.append(episodeHeading, partsElement);
            fragment.appendChild(episodeElement);
        }

        $multiPartSelectorInner.appendChild(fragment);

        $searchAllCollectionDetails.classList.remove('hidden');
        $searchAllCollectionDetails.onclick = async () => {
            if ($searchAllCollectionDetails.disabled) {
                return;
            }

            $searchAllCollectionDetails.disabled = true;
            let completed = 0;
            $searchAllCollectionDetails.textContent = `正在搜索详情 ${completed}/${episodes.length}`;
            const results = await Promise.allSettled(episodes.map(async episode => {
                await ensureEpisodeDetails(episode);
                completed++;
                $searchAllCollectionDetails.textContent = `正在搜索详情 ${completed}/${episodes.length}`;
            }));
            // 所有分P搜索完成后展开
            episodes.forEach(episode => episode.expandAfterBulkSearch());
            const failedCount = results.filter(result => result.status === 'rejected').length;
            $searchAllCollectionDetails.disabled = false;
            $searchAllCollectionDetails.textContent = '搜索全部详情';
            if (failedCount > 0) {
                alert(`${failedCount} 个合集视频详情获取失败，可展开对应 E 重试`);
            }
        };
    }

    function clearMultipart() {
        $multiPartSelectorInner.innerHTML = '';
    }

    // 分P视频全选与取消全选
    function selectAllPart() {
        document.querySelectorAll(".p-item").forEach(box => box.checked = true);
        document.querySelectorAll('.e-item').forEach(box => {
            box.checked = true;
            box.dispatchEvent(new Event('change'));
        });
    }

    function ignoreAllPart() {
        document.querySelectorAll(".p-item").forEach(box => box.checked = false);
        document.querySelectorAll('.e-item').forEach(box => {
            box.checked = false;
            box.indeterminate = false;
        });
    }

    function collectionSearch(videoData) {
        const $searchCollectionBtn = document.getElementById('searchCollectionBtn');
        const season = videoData?.ugc_season;
        $searchAllCollectionDetails.classList.add('hidden');
        $searchAllCollectionDetails.onclick = null;

        if (!season) {
            // 没有合集的视频不显示 搜索合集按钮
            $searchCollectionBtn.classList.add('hidden');
            $searchCollectionBtn.onclick = null;
            return;
        }

        $searchCollectionBtn.classList.remove('hidden');
        $searchCollectionBtn.onclick = async () => {
            console.log('搜索合集', season.id);
            console.log('合集用户', season.mid);
            const seasondata = await window.electronAPI.invoke('searchCollection', season.id, season.mid, season.ep_count
            );
            console.log('合集搜索结果:', seasondata);

            if (!seasondata.success) {
                alert(`合集搜索失败: ${seasondata.message || '未知错误'}`);
                return;
            }

            const archives = Array.isArray(seasondata.data.archives) ? seasondata.data.archives : [];
            if (archives.length < 1) {
                alert('该合集暂无可下载视频');
                return;
            }

            const episodes = archives.map((item, index) => ({
                episode: index + 1,
                title: item.title,
                bvid: item.bvid,
                aid: item.aid,
                duration: Number(item.duration) || 0,
                coverUrl: item.pic,
                archive: item,
                pages: [],
                detailsLoaded: false,
                partsRendered: false,
                selectAllRequested: false,
                loadingPromise: null
            }));

            clearMultipart();
            showMultipartSelector();
            activeCollectionEpisodes = episodes;
            addCollection(episodes);

            window.dispatchEvent(new CustomEvent('season-data-loaded', {
                detail: {
                    sourceVideo: videoData,
                    seasonData: seasondata.data,
                    episodes
                }
            }));
        };
    }

    function hideCollectionSearch() {
        const $searchCollectionBtn = document.getElementById('searchCollectionBtn');
        $searchCollectionBtn.classList.add('hidden');
        $searchCollectionBtn.onclick = null;
        $searchAllCollectionDetails.classList.add('hidden');
        $searchAllCollectionDetails.onclick = null;
        activeCollectionEpisodes = [];
    }

    async function getSubtitleInfo(bvid, cid) {
        const $subtitleSelection = document.getElementById('subtitleSelection');
        const $qualitySelectSubtitle = document.getElementById('qualitySelectSubtitle');
        $subtitleSelection.classList.add('hidden');
        $qualitySelectSubtitle.replaceChildren();

        const playerConfig = await window.electronAPI.invoke('getPlayerConfig', bvid, cid);
        const subtitles = playerConfig?.success
            ? playerConfig.data?.data?.subtitle?.subtitles
            : null;
        if (!playerConfig?.success) {
            throw new Error(playerConfig?.message || '获取字幕信息失败');
        }

        if (!Array.isArray(subtitles) || subtitles.length === 0) {
            $subtitleSelection.classList.add('hidden');
            return;
        }

        const noSubtitleOption = document.createElement('option');
        noSubtitleOption.value = '';
        noSubtitleOption.textContent = '不下载字幕';
        $qualitySelectSubtitle.appendChild(noSubtitleOption);

        subtitles.forEach((subtitle, index) => {
            const option = document.createElement('option');
            option.value = String(subtitle.lan || subtitle.id || index);
            const label = subtitle.lan_doc || subtitle.lan || `字幕 ${index + 1}`;
            const isAiSubtitle = String(subtitle.lan || '').toLowerCase().startsWith('ai-');
            option.textContent = isAiSubtitle ? `${label}（AI）` : label;
            $qualitySelectSubtitle.appendChild(option);
        });

        $subtitleSelection.classList.remove('hidden');
        console.log('获取到字幕列表:', subtitles);
        return playerConfig;
    }


    return {
        updateTitle,
        disableConfirmBtn,
        enableConfirmBtn,
        showMultipartSelector,
        addMultipart,
        addCollection,
        clearMultipart,
        updateMeta,
        updateThumbnail,
        displayStreamOptions,
        show,
        hide,
        hideMultipartSelector,
        selectAllPart,
        ignoreAllPart,
        collectionSearch,
        hideCollectionSearch,
        getSubtitleInfo
    }
}