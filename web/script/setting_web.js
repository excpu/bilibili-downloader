function createSettingWeb() {
    const settingModel = document.getElementById('settingModel');
    const settingModelCloseBtn = document.getElementById('settingModelCloseBtn');
    const $saveSettingBtn = document.getElementById('saveSettingBtn');
    const $downloadEngineSelect = document.getElementById('downloadEngineSelect');
    const $aria2ConcurrencySetting = document.getElementById('aria2ConcurrencySetting');
    const $aria2ConcurrencySelect = document.getElementById('aria2ConcurrencySelect');
    const $danmuDownloadMethodSelect = document.getElementById('danmuDownloadMethodSelect');
    const $downloadPathInput = document.getElementById('downloadPathInput');
    const $selectDownloadPathBtn = document.getElementById('selectDownloadPathBtn');
    const $cdnSelect = document.getElementById('cdnSelect');
    
    async function openSetting() {
        settingModel.classList.remove('hidden');
        showUname(globalUserInfo ? globalUserInfo.data.uname : '未登录');
        showAvatar(globalUserInfo ? globalUserInfo.data.face : 'https://static.hdslb.com/images/akari.jpg');
        await loadDownloadPath();
        await loadDownloadEngine();
        await loadAria2Concurrency();
        await loadDanmuDownloadMethod();
        await loadCdnList();
    }

    function closeSetting() {
        settingModel.classList.add('hidden');
    }

    function showUname(uname) {
        const $unameDisplay = document.getElementById('settingUserName');
        $unameDisplay.textContent = uname;
    }

    function showAvatar(avatarUrl) {
        const $avatarDisplay = document.getElementById('settingUserAvatar');
        $avatarDisplay.src = avatarUrl;
    }

    function updateAria2ConcurrencyVisibility() {
        if ($aria2ConcurrencySetting && $downloadEngineSelect) {
            $aria2ConcurrencySetting.hidden = $downloadEngineSelect.value !== 'aria2';
        }
    }

    async function loadDownloadEngine() {
        const downloadEngine = await window.electronAPI.invoke('getDownloadEngine');
        if (downloadEngine && $downloadEngineSelect) {
            $downloadEngineSelect.value = downloadEngine;
        }
        updateAria2ConcurrencyVisibility();
    }

    async function loadAria2Concurrency() {
        const concurrency = await window.electronAPI.invoke('getAria2Concurrency');
        if (concurrency && $aria2ConcurrencySelect) {
            $aria2ConcurrencySelect.value = String(concurrency);
        }
    }

    async function loadDanmuDownloadMethod() {
        const danmuDownloadMethod = await window.electronAPI.invoke('getDanmuDownloadMethod');
        if (danmuDownloadMethod && $danmuDownloadMethodSelect) {
            $danmuDownloadMethodSelect.value = danmuDownloadMethod;
        }
    }

    async function loadDownloadPath() {
        const downloadPath = await window.electronAPI.invoke('getDownloadPath');
        if (downloadPath && $downloadPathInput) {
            $downloadPathInput.value = downloadPath;
        }
    }

    async function loadCdnList() {
        if (!$cdnSelect) return;

        const [cdnList, cdnHost] = await Promise.all([
            window.electronAPI.invoke('getCdnList'),
            window.electronAPI.invoke('getCdnHost')
        ]);

        $cdnSelect.innerHTML = '<option value="">默认（不替换）</option>';

        if (cdnList && typeof cdnList === 'object') {
            for (const [region, hosts] of Object.entries(cdnList)) {
                if (!Array.isArray(hosts) || hosts.length === 0) continue;
                const $group = document.createElement('optgroup');
                $group.label = region;
                for (const host of hosts) {
                    const $option = document.createElement('option');
                    $option.value = host;
                    $option.textContent = host;
                    $group.appendChild($option);
                }
                $cdnSelect.appendChild($group);
            }
        }

        $cdnSelect.value = cdnHost || '';
    }

    async function selectDownloadPath() {
        const selectedPath = await window.electronAPI.invoke('selectDownloadPath');
        if (selectedPath && $downloadPathInput) {
            $downloadPathInput.value = selectedPath;
        }
    }

    // 切换保存下载引擎
    $downloadEngineSelect.addEventListener('change', (event) => {
        const selectedEngine = event.target.value;
        window.electronAPI.invoke('setDownloadEngine', selectedEngine);
        updateAria2ConcurrencyVisibility();
    });

    if ($aria2ConcurrencySelect) {
        $aria2ConcurrencySelect.addEventListener('change', (event) => {
            window.electronAPI.invoke('setAria2Concurrency', event.target.value);
        });
    }

    if ($danmuDownloadMethodSelect) {
        $danmuDownloadMethodSelect.addEventListener('change', (event) => {
            const selectedMethod = event.target.value;
            window.electronAPI.invoke('setDanmuDownloadMethod', selectedMethod);
        });
    }

    if ($selectDownloadPathBtn) {
        $selectDownloadPathBtn.addEventListener('click', selectDownloadPath);
    }

    if ($cdnSelect) {
        $cdnSelect.addEventListener('change', (event) => {
            window.electronAPI.invoke('setCdnHost', event.target.value);
        });
    }

    // 当前设置项为实时保存，保存按钮仅用于关闭设置弹窗
    if ($saveSettingBtn) {
        $saveSettingBtn.addEventListener('click', closeSetting);
    }


    // 用户退出登录
    const $logoutBtn = document.getElementById('logoutBtn');

    async function logout() {
        const result = await window.electronAPI.invoke('logout');
        if (result && result.success) {
            if (window.syncLoginState?.loggedOut) {
                window.syncLoginState.loggedOut();
            }
            showUname('未登录');
            showAvatar('https://static.hdslb.com/images/akari.jpg');
            if ($loginSection) {
                $loginSection.classList.add('hidden');
            }
            closeSetting();
        }
    }

    if ($logoutBtn) {
        $logoutBtn.addEventListener('click', logout);
    }




    // 绑定关闭按钮事件
    if (settingModelCloseBtn) {
        settingModelCloseBtn.addEventListener('click', closeSetting);
    }

    // 点击背景关闭弹窗
    if (settingModel) {
        settingModel.addEventListener('click', (e) => {
            if (e.target === settingModel) {
                closeSetting();
            }
        });
    }


    return {
        openSetting,
        closeSetting,
        showUname
    }
}

const settingWeb = createSettingWeb();