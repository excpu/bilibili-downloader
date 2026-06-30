function createSettingWeb() {
    const settingModel = document.getElementById('settingModel');
    const settingModelCloseBtn = document.getElementById('settingModelCloseBtn');
    const $saveSettingBtn = document.getElementById('saveSettingBtn');
    const $downloadEngineSelect = document.getElementById('downloadEngineSelect');
    const $downloadPathInput = document.getElementById('downloadPathInput');
    const $selectDownloadPathBtn = document.getElementById('selectDownloadPathBtn');
    
    async function openSetting() {
        settingModel.classList.remove('hidden');
        showUname(globalUserInfo ? globalUserInfo.data.uname : '未登录');
        showAvatar(globalUserInfo ? globalUserInfo.data.face : 'https://static.hdslb.com/images/akari.jpg');
        await loadDownloadPath();
        await loadDownloadEngine();
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

    async function loadDownloadEngine() {
        const downloadEngine = await window.electronAPI.invoke('getDownloadEngine');
        if (downloadEngine && $downloadEngineSelect) {
            $downloadEngineSelect.value = downloadEngine;
        }
    }

    async function loadDownloadPath() {
        const downloadPath = await window.electronAPI.invoke('getDownloadPath');
        if (downloadPath && $downloadPathInput) {
            $downloadPathInput.value = downloadPath;
        }
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
    });

    if ($selectDownloadPathBtn) {
        $selectDownloadPathBtn.addEventListener('click', selectDownloadPath);
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