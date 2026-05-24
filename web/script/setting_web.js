function createSettingWeb() {
    const settingModel = document.getElementById('settingModel');
    const settingModelCloseBtn = document.getElementById('settingModelCloseBtn');
    const $downloadEngineSelect = document.getElementById('downloadEngineSelect');
    
    async function openSetting() {
        settingModel.classList.remove('hidden');
        showUname(globalUserInfo ? globalUserInfo.data.uname : '未登录');
        showAvatar(globalUserInfo ? globalUserInfo.data.face : 'https://static.hdslb.com/images/akari.jpg');
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

    // 切换保存下载引擎
    $downloadEngineSelect.addEventListener('change', (event) => {
        const selectedEngine = event.target.value;
        window.electronAPI.invoke('setDownloadEngine', selectedEngine);
    });


    // 用户退出登录




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