// 收藏 / 历史记录选择器：入口按钮 -> 模态框 -> 选择视频 -> 走链接下载流程
const libraryPicker = (() => {
    const $libraryModel = document.getElementById('libraryModel');
    const $libraryModelTitle = document.getElementById('libraryModelTitle');
    const $libraryModelCloseBtn = document.getElementById('libraryModelCloseBtn');
    const $favList = document.getElementById('libraryFavList');
    const $videoList = document.getElementById('libraryVideoList');

    // 当前模态框状态
    let mode = null; // 'history' | 'fav'
    let historyCursor = null; // { max, view_at, business }
    let historyExhausted = false;
    let favCurrent = null; // { mediaId, pn, kind, seasonId, mid, upper }
    let favFolders = []; // getFavFolders 返回的完整列表（含 kind/ownerMid）
    let favHasMore = false;
    let loading = false;
    let picking = false;

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function formatDuration(seconds) {
        const s = Math.max(0, Math.floor(Number(seconds) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        const mm = String(m).padStart(2, '0');
        const ss = String(sec).padStart(2, '0');
        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    // 历史记录按天分组：今天 / 昨天 / YYYY-MM-DD
    function dayLabel(timestamp) {
        const date = new Date(timestamp * 1000);
        const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const diffDays = Math.round((todayStart.getTime() - startOfDay) / 86400000);
        if (diffDays <= 0) return '今天';
        if (diffDays === 1) return '昨天';
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${mo}-${d}`;
    }

    function timeLabel(timestamp) {
        const date = new Date(timestamp * 1000);
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        return `${dayLabel(timestamp)} ${hh}:${mi}`;
    }

    function renderVideoItem(item) {
        const duration = item.duration ? formatDuration(item.duration) : '';
        const isCollection = item.kind === 'collection';
        const invalid = !!item.invalid;
        const kindAttr = isCollection ? 'collection' : 'video';
        const payload = isCollection
            ? `data-season-id="${escapeHtml(item.seasonId)}"${item.mid ? ` data-mid="${escapeHtml(item.mid)}"` : ''} data-title="${escapeHtml(item.title)}" data-cover="${escapeHtml(item.cover)}"`
            : '';
        return `
            <div class="library-item${invalid ? ' invalid' : ''}" data-kind="${kindAttr}" data-invalid="${invalid ? '1' : ''}" data-bvid="${escapeHtml(item.bvid)}" ${payload} role="button" tabindex="0"${invalid ? ' aria-disabled="true"' : ''}>
                <div class="library-thumb">
                    <img src="${escapeHtml(item.cover)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.style.visibility='hidden'" />
                    ${isCollection ? '<span class="library-duration library-collection-tag">合集</span>' : ''}
                    ${invalid ? '<span class="library-duration library-invalid-tag">失效</span>' : ''}
                    ${!isCollection && duration ? `<span class="library-duration">${escapeHtml(duration)}</span>` : ''}
                </div>
                <div class="library-detail">
                    <div class="library-title">${escapeHtml(item.title)}</div>
                    <div class="library-meta">
                        <span class="history-icon" aria-hidden="true"></span>
                        <span>${escapeHtml(item.timeText)}</span>
                        <span>·</span>
                        <span>${escapeHtml(item.upper)}</span>
                    </div>
                </div>
            </div>`;
    }

    function setStatus(text) {
        $videoList.innerHTML = `<div class="library-status">${escapeHtml(text)}</div>`;
    }

    function hasMorePages() {
        return mode === 'history' ? !historyExhausted : favHasMore;
    }

    // ---- 底部状态条：滑到底部自动加载下一页 ----
    let footerObserver = null;

    function setFooter(state, text) {
        footerObserver?.disconnect();
        // 列表还没有任何条目时不显示"加载更多/已加载全部"，避免和空状态提示叠加
        if ((state === 'more' || state === 'end') && !$videoList.querySelector('.library-item')) return;
        $videoList.querySelector('.library-footer')?.remove();
        const $el = document.createElement('div');
        $el.className = `library-footer ${state}`;
        $el.setAttribute('aria-live', 'polite');
        if (state === 'loading') {
            $el.innerHTML = '<span class="library-footer-spinner" aria-hidden="true"></span><span>加载中…</span>';
        } else if (state === 'error') {
            $el.innerHTML = `<span class="library-footer-text">${escapeHtml(text || '加载失败')}</span>`
                + '<button type="button" class="library-footer-retry">重试</button>';
            $el.querySelector('.library-footer-retry').addEventListener('click', () => autoLoadNext());
        } else if (state === 'end') {
            $el.innerHTML = `<span class="library-footer-text">${escapeHtml(text || '已加载全部内容')}</span>`;
        } else {
            $el.innerHTML = '<span class="library-footer-text">继续下滑加载更多</span>';
        }
        $videoList.appendChild($el);
        // 只有"下滑加载更多"状态才需要观察是否触底
        if (state !== 'more') return;
        footerObserver = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) autoLoadNext();
        }, { root: $videoList, rootMargin: '0px 0px 120px 0px', threshold: 0 });
        footerObserver.observe($el);
        // 内容不足一屏时 IO 不会再触发，这里主动检查一次可见性
        requestAnimationFrame(() => {
            const listRect = $videoList.getBoundingClientRect();
            const elRect = $el.getBoundingClientRect();
            if (elRect.top < listRect.bottom + 120) autoLoadNext();
        });
    }

    // 按当前分页状态刷新底部提示
    function refreshFooter() {
        setFooter(hasMorePages() ? 'more' : 'end');
    }

    function autoLoadNext() {
        if (loading || picking || !hasMorePages()) return;
        loadNextPage();
    }

    // ---- 数据加载 ----

    async function loadHistoryPage(append) {
        const res = await window.electronAPI.invoke('getWatchHistory', historyCursor);
        if (!res.success) {
            if (res.code === -101) {
                $avatar.click(); // 复用登录流程
                close();
                return { handled: true };
            }
            return { error: res.message || '获取历史记录失败' };
        }
        const items = (res.list || []).map(item => ({
            bvid: item.history.bvid,
            title: item.title,
            cover: item.cover,
            duration: item.duration,
            upper: item.author_name,
            viewAt: item.view_at,
        }));
        if (!append) {
            renderHistoryList(items);
        } else {
            appendHistoryItems(items);
        }
        historyCursor = res.cursor && res.rawCount ? {
            max: res.cursor.max,
            view_at: res.cursor.view_at,
            business: res.cursor.business,
        } : null;
        historyExhausted = !res.rawCount;
        return { count: items.length };
    }

    function historyGroupedHtml(items) {
        let html = '';
        let lastLabel = null;
        for (const item of items) {
            const label = dayLabel(item.viewAt);
            if (label !== lastLabel) {
                html += `<div class="library-group-title">${escapeHtml(label)}</div>`;
                lastLabel = label;
            }
            html += renderVideoItem({ ...item, timeText: timeLabel(item.viewAt) });
        }
        return html;
    }

    function renderHistoryList(items) {
        if (!items.length) {
            setStatus('暂无观看历史');
            return;
        }
        $videoList.innerHTML = historyGroupedHtml(items);
    }

    function appendHistoryItems(items) {
        $videoList.querySelector('.library-footer')?.remove();
        $videoList.querySelector('.library-status')?.remove();
        $videoList.insertAdjacentHTML('beforeend', historyGroupedHtml(items));
    }

    async function loadFavFolders() {
        $favList.innerHTML = '<div class="library-status">加载中…</div>';
        const res = await window.electronAPI.invoke('getFavFolders');
        if (!res.success) {
            $favList.innerHTML = '';
            if (res.code === -101) {
                $avatar.click();
                close();
                return;
            }
            setStatus(res.message || '获取收藏夹列表失败');
            return;
        }
        if (!res.folders.length) {
            $favList.innerHTML = '<div class="library-status">暂无收藏夹</div>';
            setStatus('暂无收藏夹');
            return;
        }
        favFolders = res.folders;
        // 分组：我创建的收藏夹 / 我收藏的（含追的合集，合集走另一套接口）
        const groupHtml = (label, list) => {
            if (!list.length) return '';
            return `<div class="fav-group-title">${escapeHtml(label)}</div>` + list.map(folder => `
                <div class="fav-folder" data-media-id="${escapeHtml(folder.id)}" role="button" tabindex="0">
                    <span class="fav-folder-title"><span class="fav-folder-name" title="${escapeHtml(folder.upper ? `${folder.title} · ${folder.upper}` : folder.title)}">${escapeHtml(folder.title)}</span>${folder.kind === 'season' ? '<span class="fav-folder-season-tag">合集</span>' : ''}</span>
                    <span class="fav-folder-count">${escapeHtml(folder.media_count)}</span>
                </div>`).join('');
        };
        $favList.innerHTML = [
            groupHtml('我创建的', res.folders.filter(f => f.own)),
            groupHtml('我收藏的', res.folders.filter(f => !f.own)),
        ].join('');
        // 默认打开第一个
        await selectFavFolder(res.folders[0].id);
    }

    async function selectFavFolder(mediaId) {
        $favList.querySelectorAll('.fav-folder').forEach($el => {
            $el.classList.toggle('active', $el.dataset.mediaId === String(mediaId));
        });
        const folder = favFolders.find(f => String(f.id) === String(mediaId)) || null;
        favCurrent = {
            mediaId,
            pn: 1,
            kind: folder?.kind || 'folder',
            seasonId: folder?.id,
            mid: folder?.ownerMid,
            upper: folder?.upper || '',
        };
        favHasMore = false;
        setStatus('加载中…');
        await loadFavResourcesPage(false);
        refreshFooter();
    }

    async function loadFavResourcesPage(append) {
        const res = await window.electronAPI.invoke('getFavResources', {
            mediaId: favCurrent.mediaId,
            pn: favCurrent.pn,
            kind: favCurrent.kind,
            seasonId: favCurrent.seasonId,
            mid: favCurrent.mid,
            upper: favCurrent.upper,
        });
        if (!res.success) {
            return { error: res.message || '获取收藏夹内容失败' };
        }
        const isSeason = favCurrent.kind === 'season';
        const items = (res.medias || [])
            .map(item => ({
                kind: item.kind,
                bvid: item.bvid,
                seasonId: item.seasonId,
                mid: item.mid,
                title: item.title,
                cover: item.cover,
                duration: item.duration,
                upper: item.upper,
                invalid: item.invalid,
                timeText: isSeason ? `发布于 ${dayLabel(item.pub_time)}` : `收藏于 ${dayLabel(item.fav_time)}`,
            }));
        favHasMore = !!res.hasMore && items.length > 0;
        if (!append) {
            if (!items.length) {
                setStatus('该收藏夹暂无内容');
            } else {
                $videoList.innerHTML = items.map(renderVideoItem).join('');
            }
        } else {
            $videoList.querySelector('.library-footer')?.remove();
            $videoList.insertAdjacentHTML('beforeend', items.map(renderVideoItem).join(''));
        }
        if (items.length && !append) $videoList.scrollTop = 0;
        return { count: items.length };
    }

    async function loadNextPage() {
        if (loading) return;
        loading = true;
        setFooter('loading');
        try {
            let result;
            if (mode === 'history') {
                result = await loadHistoryPage(true);
            } else {
                favCurrent.pn += 1;
                result = await loadFavResourcesPage(true);
            }
            if (result?.handled) return;
            if (result?.error) {
                if (mode === 'fav') favCurrent.pn -= 1;
                model.showErrorMessage(result.error);
                setFooter('error', `${result.error}，点击重试`);
            } else {
                refreshFooter();
            }
        } finally {
            loading = false;
        }
    }

    // ---- 打开 / 关闭 ----

    async function open(nextMode) {
        mode = nextMode;
        historyCursor = null;
        historyExhausted = false;
        favCurrent = null;
        favFolders = [];
        favHasMore = false;
        loading = false;
        $libraryModelTitle.textContent = nextMode === 'history' ? '历史记录' : '我的收藏';
        $favList.classList.toggle('hidden', nextMode !== 'fav');
        setStatus('加载中…');
        $libraryModel.classList.remove('hidden');

        loading = true;
        try {
            if (nextMode === 'history') {
                const result = await loadHistoryPage(false);
                if (result?.handled) return;
                if (result?.error) {
                    setStatus(result.error);
                } else {
                    refreshFooter();
                }
            } else {
                await loadFavFolders();
            }
        } finally {
            loading = false;
        }
    }

    function close() {
        footerObserver?.disconnect();
        $libraryModel.classList.add('hidden');
    }

    // ---- 选择视频 / 合集：填入输入框并复用链接下载流程 ----

    function pickVideo(bvid) {
        if (!bvid) return;
        close();
        $urlInput.value = `https://www.bilibili.com/video/${bvid}/`;
        downloadLock = true;
        getVideoInfo();
    }

    // 收藏夹里的视频合集：先解析合集第一集，走链接下载流程，再自动展开合集选择器
    async function pickCollection($item) {
        if (picking) return;
        const seasonId = $item.dataset.seasonId;
        const mid = $item.dataset.mid;
        if (!seasonId || !mid) {
            // 缺少合集参数时退回普通视频流程（合集条目偶尔也带 bvid）
            if ($item.dataset.bvid) {
                pickVideo($item.dataset.bvid);
            } else {
                model.showErrorMessage('该合集信息不完整，无法打开');
            }
            return;
        }
        picking = true;
        $item.classList.add('picking');
        try {
            const res = await window.electronAPI.invoke('getCollectionFirstVideo', { seasonId, mid });
            if (!res.success) {
                model.showErrorMessage(res.message || '获取合集信息失败');
                return;
            }
            close();
            $urlInput.value = `https://www.bilibili.com/video/${res.bvid}/`;
            downloadLock = true;
            await getVideoInfo();
            // 第一集信息获取失败时 currentVideoIdentity 不会更新，此时不展开合集
            if (currentVideoIdentity?.bvid !== res.bvid) return;
            // 合集的第一条稿件信息里带有 ugc_season，直接展开合集选择器
            await infoSection.openCollection(seasonId, mid, res.total, {
                bvid: currentVideoIdentity.bvid,
                cid: currentVideoIdentity.cid ?? currentVideoIdentity.subtitleCid ?? null,
                title: $item.dataset.title || currentVideoIdentity.title || '',
                pic: currentVideoIdentity.coverUrl || $item.dataset.cover || '',
                pages: [],
            });
        } catch (error) {
            model.showErrorMessage(`打开合集失败: ${error.message}`);
        } finally {
            picking = false;
            $item.classList.remove('picking');
        }
    }

    function pickFromItem($item) {
        if ($item.dataset.invalid) {
            model.showErrorMessage('该视频已失效，无法下载');
            return;
        }
        if ($item.dataset.kind === 'collection') {
            pickCollection($item);
        } else {
            pickVideo($item.dataset.bvid);
        }
    }

    // ---- 事件绑定 ----

    document.getElementById('pickFromFavBtn').addEventListener('click', () => open('fav'));
    document.getElementById('pickFromHistoryBtn').addEventListener('click', () => open('history'));
    $libraryModelCloseBtn.addEventListener('click', close);
    $libraryModel.addEventListener('click', (event) => {
        if (event.target === $libraryModel) close();
    });

    $videoList.addEventListener('click', (event) => {
        const $item = event.target.closest('.library-item');
        if ($item) pickFromItem($item);
    });
    $videoList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const $item = event.target.closest('.library-item');
        if ($item) {
            event.preventDefault();
            pickFromItem($item);
        }
    });

    $favList.addEventListener('click', (event) => {
        const $folder = event.target.closest('.fav-folder');
        if ($folder) selectFavFolder($folder.dataset.mediaId);
    });
    $favList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const $folder = event.target.closest('.fav-folder');
        if ($folder) {
            event.preventDefault();
            selectFavFolder($folder.dataset.mediaId);
        }
    });

    return { open, close };
})();
