function createNavBar() {
    const area = document.getElementById('avatarArea');
    const avatar = document.getElementById('avatar');
    const popover = document.getElementById('accountPopover');
    const elements = Object.fromEntries([
        'Name', 'Vip', 'Coins', 'Bcoins', 'Level', 'NextLevel', 'LevelProgress',
        'Experience', 'Following', 'Followers', 'Dynamics', 'Status',
        'PortraitFace', 'PortraitFrame', 'PortraitPlaceholder'
    ].map((name) => [name, document.getElementById(`account${name}`)]));
    let user = null;
    let requestId = 0;
    let showing = false;
    let lastRequestAt = null;
    let refreshing = false;
    const cacheDuration = 5 * 60 * 1000;

    function number(value) {
        return typeof value === 'number' && Number.isFinite(value) ? String(value) : '--';
    }

    function setImage(element, url) {
        if (typeof url !== 'string' || !url.trim()) {
            element.hidden = true;
            element.removeAttribute('src');
        } else if (element.getAttribute('src') !== url) {
            element.hidden = false;
            element.setAttribute('src', url);
        }
    }

    elements.PortraitFace.addEventListener('load', () => {
        elements.PortraitPlaceholder.hidden = true;
    });
    elements.PortraitFace.addEventListener('error', () => {
        elements.PortraitFace.hidden = true;
        elements.PortraitPlaceholder.hidden = false;
        console.error('账户头像加载失败');
    });
    elements.PortraitFrame.addEventListener('error', () => {
        elements.PortraitFrame.hidden = true;
        console.error('账户头像框加载失败');
    });

    function renderUser(data) {
        if (elements.PortraitFace.getAttribute('src') !== data.face) {
            elements.PortraitPlaceholder.hidden = false;
        }
        setImage(elements.PortraitFace, data.face);
        setImage(elements.PortraitFrame, data.pendant && data.pendant.image);
        elements.Name.textContent = data.uname || '用户名不可用';
        const vip = data.vipStatus === 1;
        elements.Name.classList.toggle('is-vip', vip);
        elements.Vip.hidden = !vip;
        elements.Vip.textContent = vip ? (data.vip_label && data.vip_label.text || '大会员') : '';
        elements.Coins.textContent = number(data.money);
        elements.Bcoins.textContent = number(data.wallet && data.wallet.bcoin_balance);

        const level = data.level_info;
        const current = level && level.current_level;
        const exp = level && level.current_exp;
        const min = level && level.current_min;
        const next = level && level.next_exp;
        const validLevel = Number.isInteger(current) && current >= 0 && current <= 6;
        elements.Level.textContent = validLevel ? `LV${current}` : '--';
        elements.NextLevel.textContent = validLevel ? `LV${Math.min(current + 1, 6)}` : '--';
        let progress = 0;
        if (validLevel && typeof exp === 'number' && Number.isFinite(exp)) {
            if (current === 6) {
                progress = 100;
                elements.Experience.textContent = `当前成长${exp}，已达到最高等级`;
            } else if (typeof min === 'number' && Number.isFinite(min) &&
                typeof next === 'number' && Number.isFinite(next) && next > min) {
                progress = Math.max(0, Math.min(100, (exp - min) / (next - min) * 100));
                elements.Experience.textContent = `当前成长${exp}，距离升级Lv.${current + 1}还需要${Math.max(0, next - exp)}`;
            } else {
                elements.Experience.textContent = `当前成长${exp}，升级经验不可用`;
            }
        } else {
            elements.Experience.textContent = '等级信息不可用';
        }
        elements.LevelProgress.style.width = `${progress}%`;
    }

    function resetStats() {
        elements.Following.textContent = '--';
        elements.Followers.textContent = '--';
        elements.Dynamics.textContent = '--';
    }

    async function refresh(includeUserInfo) {
        if (!user || refreshing || (lastRequestAt !== null && Date.now() - lastRequestAt <= cacheDuration)) return;
        lastRequestAt = Date.now();
        refreshing = true;
        const id = ++requestId;
        const mid = user.mid;
        elements.Status.textContent = '';
        const results = await Promise.allSettled([
            includeUserInfo ? window.electronAPI.invoke('getUserInfo') : Promise.resolve(null),
            window.electronAPI.invoke('getUserNavStats', mid)
        ]);
        if (id !== requestId || !user || user.mid !== mid) return;
        refreshing = false;

        const errors = [];
        const info = results[0];
        if (includeUserInfo) {
            if (info.status === 'fulfilled' && info.value.status && info.value.data &&
                info.value.data.isLogin && info.value.data.mid === mid) {
                user = info.value.data;
                renderUser(user);
            } else {
                errors.push('账户信息更新失败');
                console.error('账户信息更新失败:', info.status === 'rejected' ? info.reason : info.value && info.value.message);
            }
        }
        const stats = results[1];
        if (stats.status === 'fulfilled' && stats.value.success) {
            const { relation, navnum } = stats.value;
            const following = number(relation && relation.following);
            const followers = number(relation && relation.follower);
            const dynamics = number(navnum && navnum.opus);
            if (following !== '--') elements.Following.textContent = following;
            if (followers !== '--') elements.Followers.textContent = followers;
            if (dynamics !== '--') elements.Dynamics.textContent = dynamics;
            if (stats.value.errors.length || following === '--' || followers === '--' || dynamics === '--') {
                errors.push('统计数据更新失败');
                console.error('账户统计更新失败:', stats.value.errors.join('；') || '接口返回的数据不完整');
            }
        } else {
            errors.push('统计数据更新失败');
            console.error('账户统计更新失败:', stats.status === 'rejected' ? stats.reason : stats.value && stats.value.message);
        }
        elements.Status.textContent = errors.join('；');
    }

    function show() {
        if (!user || showing) return;
        showing = true;
        popover.hidden = false;
        avatar.setAttribute('aria-expanded', 'true');
        refresh(true);
    }

    function hide() {
        showing = false;
        popover.hidden = true;
        avatar.setAttribute('aria-expanded', 'false');
    }

    area.addEventListener('mouseenter', show);
    area.addEventListener('mouseleave', hide);
    avatar.addEventListener('focus', show);
    area.addEventListener('focusout', (event) => {
        if (!area.contains(event.relatedTarget) && !area.matches(':hover')) hide();
    });
    avatar.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hide();
    });

    return {
        setUser(data) {
            const isNewUser = !user || user.mid !== data.mid;
            if (isNewUser) {
                hide();
                requestId++;
                refreshing = false;
                lastRequestAt = null;
                resetStats();
                elements.Status.textContent = '';
            }
            user = data;
            renderUser(data);
            if (isNewUser) refresh(false);
            if (area.matches(':hover') || document.activeElement === avatar) show();
        },
        clear() {
            hide();
            requestId++;
            refreshing = false;
            lastRequestAt = null;
            user = null;
            resetStats();
            setImage(elements.PortraitFace, null);
            setImage(elements.PortraitFrame, null);
            elements.PortraitPlaceholder.hidden = false;
            elements.Status.textContent = '';
        }
    };
}
