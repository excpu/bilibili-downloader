function createSettingWeb() {
    const settingModel = document.getElementById('settingModel');
    const $saveSettingBtn = document.getElementById('saveSettingBtn');
    const $downloadEngineSelect = document.getElementById('downloadEngineSelect');
    const $concurrencySetting = document.getElementById('concurrencySetting');
    const $concurrencySelect = document.getElementById('concurrencySelect');
    const $nodeResumeCheckbox = document.getElementById('nodeResumeCheckbox');
    const $danmuDownloadMethodSelect = document.getElementById('danmuDownloadMethodSelect');
    const $themeSelect = document.getElementById('themeSelect');
    const $modalMorphCheckbox = document.getElementById('modalMorphCheckbox');
    const $downloadPathInput = document.getElementById('downloadPathInput');
    const $selectDownloadPathBtn = document.getElementById('selectDownloadPathBtn');
    const $downloadInFolderCheckbox = document.getElementById('downloadInFolderCheckbox');
    const $downloadFolderNestingSetting = document.getElementById('downloadFolderNestingSetting');
    const $downloadFolderNestingCheckbox = document.getElementById('downloadFolderNestingCheckbox');
    const $previewMultiThreadCheckbox = document.getElementById('previewMultiThreadCheckbox');
    // 两组共用同一份远端 CDN 列表，只需拉取一次
    let currentCdnList = null;
    // CDN 选择组工厂：下载 CDN 与播放 CDN 共用同一套交互，只是读写的设置项不同
    const cdnDownloadGroup = createCdnGroup({
        selectId: 'cdnSelect',
        customSettingId: 'cdnCustomHostSetting',
        inputId: 'cdnCustomHostInput',
        saveBtnId: 'cdnCustomHostSaveBtn',
        cancelBtnId: 'cdnCustomHostCancelBtn',
        hintId: 'cdnCustomHostHint',
        getChannel: 'getCdnHost',
        setChannel: 'setCdnHost',
        customHint: '可直接粘贴完整下载链接或域名，保存时只保留主机名。',
    });
    const cdnPlayGroup = createCdnGroup({
        selectId: 'playCdnSelect',
        customSettingId: 'playCdnCustomHostSetting',
        inputId: 'playCdnCustomHostInput',
        saveBtnId: 'playCdnCustomHostSaveBtn',
        cancelBtnId: 'playCdnCustomHostCancelBtn',
        hintId: 'playCdnCustomHostHint',
        getChannel: 'getPlayCdnHost',
        setChannel: 'setPlayCdnHost',
        customHint: '可直接粘贴完整播放链接或域名，保存时只保留主机名。',
    });
    const $outputFormatSelect = document.getElementById('outputFormatSelect');
    const $mp4NonStandardAudioSetting = document.getElementById('mp4NonStandardAudioSetting');
    const $mp4NonStandardAudioHint = document.getElementById('mp4NonStandardAudioHint');
    const $mp4NonStandardAudioCheckbox = document.getElementById('mp4NonStandardAudioCheckbox');
    const $subtitleFormatSelect = document.getElementById('subtitleFormatSelect');
    const $assSubtitleSettings = document.getElementById('assSubtitleSettings');
    const $subtitleAppendLanguage = document.getElementById('subtitleAppendLanguage');
    const $assOptionInputs = [...document.querySelectorAll('[data-ass-option]')];
    const $danmakuConvertToAss = document.getElementById('danmakuConvertToAss');
    const $danmakuConvertStandalone = document.getElementById('danmakuConvertStandalone');
    const $danmakuKeepXml = document.getElementById('danmakuKeepXml');
    const $danmakuAssSettings = document.getElementById('danmakuAssSettings');
    const $danmakuOptionInputs = [...document.querySelectorAll('[data-danmaku-option]')];

    async function openSetting(trigger) {
        openModal(settingModel, trigger);
        showUname(globalUserInfo ? globalUserInfo.data.uname : '未登录');
        showAvatar(globalUserInfo ? globalUserInfo.data.face : 'https://static.hdslb.com/images/akari.jpg');
        await loadDownloadPath();
        await loadFolderSettings();
        await loadDownloadEngine();
        await loadConcurrency();
        await loadDanmuDownloadMethod();
        await loadTheme();
        await loadModalMorph();
        await loadCdnList();
        await loadPreviewMultiThread();
        await loadOutputFormat();
        await loadSubtitleSettings();
        await loadDanmakuSettings();
        selectSettingTab('basicSettingsTab');
    }

    function closeSetting() {
        closeModal(settingModel);
    }

    function showUname(uname) {
        const $unameDisplay = document.getElementById('settingUserName');
        $unameDisplay.textContent = uname;
    }

    function showAvatar(avatarUrl) {
        const $avatarDisplay = document.getElementById('settingUserAvatar');
        $avatarDisplay.src = avatarUrl;
    }

    // 并发线程数只对多线程引擎有意义
    function updateConcurrencyVisibility() {
        if ($concurrencySetting && $downloadEngineSelect) {
            const engine = $downloadEngineSelect.value;
            const isMulti = engine === 'node-multi';
            $concurrencySetting.classList.toggle('hidden', !isMulti);
            const $resume = document.getElementById('nodeResumeSetting');
            if ($resume) $resume.classList.toggle('hidden', !isMulti);
        }
    }

    async function loadDownloadEngine() {
        const downloadEngine = await window.electronAPI.invoke('getDownloadEngine');
        if (downloadEngine && $downloadEngineSelect) {
            $downloadEngineSelect.value = downloadEngine;
        }
        if ($nodeResumeCheckbox) {
            $nodeResumeCheckbox.checked = await window.electronAPI.invoke('getNodeResumeEnabled');
        }
        updateConcurrencyVisibility();
    }

    async function loadConcurrency() {
        const concurrency = await window.electronAPI.invoke('getConcurrency');
        if (concurrency && $concurrencySelect) {
            $concurrencySelect.value = String(concurrency);
        }
    }

    async function loadDanmuDownloadMethod() {
        const danmuDownloadMethod = await window.electronAPI.invoke('getDanmuDownloadMethod');
        if (danmuDownloadMethod && $danmuDownloadMethodSelect) {
            $danmuDownloadMethodSelect.value = danmuDownloadMethod;
        }
    }

    async function loadTheme() {
        const theme = await window.electronAPI.invoke('getTheme');
        if (theme && $themeSelect) {
            $themeSelect.value = theme;
        }
    }

    async function loadModalMorph() {
        const enabled = await window.electronAPI.invoke('getModalMorphEnabled');
        if ($modalMorphCheckbox) {
            $modalMorphCheckbox.checked = enabled !== false;
        }
        setModalMorphEnabled(enabled !== false);
    }

    async function loadOutputFormat() {
        const [format, allowNonStandard] = await Promise.all([
            window.electronAPI.invoke('getOutputFormat'),
            window.electronAPI.invoke('getMp4AllowNonStandardAudio')
        ]);
        if (format && $outputFormatSelect) {
            $outputFormatSelect.value = format;
        }
        if ($mp4NonStandardAudioCheckbox) {
            $mp4NonStandardAudioCheckbox.checked = allowNonStandard !== false;
        }
        updateMp4NonStandardAudioVisibility();
    }

    // 非标封装选项只对 MP4 有意义，选择 MKV 时隐藏
    function updateMp4NonStandardAudioVisibility() {
        if (!$mp4NonStandardAudioSetting || !$outputFormatSelect) return;
        const visible = $outputFormatSelect.value === 'mp4';
        $mp4NonStandardAudioSetting.classList.toggle('hidden', !visible);
        if ($mp4NonStandardAudioHint) {
            $mp4NonStandardAudioHint.classList.toggle('hidden', !visible);
        }
    }

    async function loadDownloadPath() {
        const downloadPath = await window.electronAPI.invoke('getDownloadPath');
        if (downloadPath && $downloadPathInput) {
            $downloadPathInput.value = downloadPath;
        }
    }

    // 嵌套开关仅在勾选"创建文件夹"时显示
    function updateNestingVisibility() {
        if (!$downloadFolderNestingSetting || !$downloadInFolderCheckbox) return;
        $downloadFolderNestingSetting.classList.toggle('hidden', !$downloadInFolderCheckbox.checked);
    }

    async function loadFolderSettings() {
        const [inFolder, nesting] = await Promise.all([
            window.electronAPI.invoke('getDownloadInFolder'),
            window.electronAPI.invoke('getDownloadFolderNesting')
        ]);
        if ($downloadInFolderCheckbox) {
            $downloadInFolderCheckbox.checked = inFolder === true;
        }
        if ($downloadFolderNestingCheckbox) {
            $downloadFolderNestingCheckbox.checked = nesting === true;
        }
        updateNestingVisibility();
    }

    // 下拉框中代表"自定义 CDN"的占位值，本身不会写入配置
    const CDN_CUSTOM_VALUE = '__custom__';

    // 下载 CDN 与播放 CDN 行为完全一致，用工厂生成两组互不干扰的状态与处理逻辑
    function createCdnGroup(options) {
        const $select = document.getElementById(options.selectId);
        const $customSetting = document.getElementById(options.customSettingId);
        const $customInput = document.getElementById(options.inputId);
        const $customSaveBtn = document.getElementById(options.saveBtnId);
        const $customCancelBtn = document.getElementById(options.cancelBtnId);
        const $hint = document.getElementById(options.hintId);

        let currentHost = '';
        // 下拉框是否处于"自定义 CDN"状态：只有该状态才显示输入区
        let customMode = false;

        function isPresetHost(host) {
            if (!host || !currentCdnList || typeof currentCdnList !== 'object') return false;
            return Object.values(currentCdnList).some(
                (hosts) => Array.isArray(hosts) && hosts.includes(host)
            );
        }

        // 既不是"默认"也不在预设列表里的主机，视为用户自定义的 CDN
        function isCustomHost(host) {
            return Boolean(host) && !isPresetHost(host);
        }

        // 重建下拉选项：自定义项紧跟"默认"，预设 CDN 按地区分组排在其后
        function renderOptions() {
            if (!$select) return;

            $select.innerHTML = '<option value="">默认（不替换）</option>';

            const $customOption = document.createElement('option');
            $customOption.value = CDN_CUSTOM_VALUE;
            $customOption.textContent = '自定义 CDN…';
            $select.appendChild($customOption);

            if (currentCdnList && typeof currentCdnList === 'object') {
                for (const [region, hosts] of Object.entries(currentCdnList)) {
                    if (!Array.isArray(hosts) || hosts.length === 0) continue;
                    const $group = document.createElement('optgroup');
                    $group.label = region;
                    for (const host of hosts) {
                        const $option = document.createElement('option');
                        $option.value = host;
                        $option.textContent = host;
                        $group.appendChild($option);
                    }
                    $select.appendChild($group);
                }
            }

            // 自定义主机不单列选项，统一回显为"自定义 CDN"，域名显示在输入框里
            $select.value = customMode ? CDN_CUSTOM_VALUE : (currentHost || '');
        }

        function setHint(text, isError) {
            if (!$hint) return;
            $hint.textContent = text;
            $hint.classList.toggle('cdn-hint-error', Boolean(isError));
        }

        // 只有选中"自定义 CDN"时才展开输入区，预设 CDN 只改设置不显示输入框
        function setCustomAreaVisible(visible, focus = false) {
            customMode = Boolean(visible);
            if ($customSetting) {
                $customSetting.classList.toggle('hidden', !visible);
            }
            if (visible && focus && $customInput) {
                $customInput.focus();
                $customInput.select();
            }
        }

        function resetCustomHint() {
            setHint(options.customHint, false);
        }

        async function load() {
            if (!$select) return;

            const host = await window.electronAPI.invoke(options.getChannel);
            currentHost = host || '';
            customMode = isCustomHost(currentHost);
            renderOptions();
            if ($customInput) {
                $customInput.value = customMode ? currentHost : '';
            }
            // 打开设置时若已存自定义 CDN，直接展开输入区，但不抢占焦点
            setCustomAreaVisible(customMode);
            setHint(options.customHint, false);
        }

        function cancelCustomHost() {
            // 取消后回到已保存的设置：自定义的保持展开并回填，预设/默认则收起
            const keepCustom = isCustomHost(currentHost);
            setCustomAreaVisible(keepCustom);
            renderOptions();
            if ($customInput) {
                $customInput.value = keepCustom ? currentHost : '';
            }
            resetCustomHint();
        }

        async function saveCustomHost() {
            if (!$customInput) return;

            const raw = $customInput.value.trim();
            const normalized = raw
                ? await window.electronAPI.invoke('normalizeCdnHost', raw)
                : '';

            if (raw && !normalized) {
                setHint('主机名无效，请填写例如 upos-sz-mirrorcos.bilivideo.com 的域名。', true);
                $customInput.focus();
                return;
            }

            const saved = await window.electronAPI.invoke(options.setChannel, normalized);
            currentHost = saved || '';
            // 保存后仍停留在自定义态；若填的恰是预设域名，下拉框会切回该预设项并收起输入区
            const keepCustom = Boolean(currentHost) && !isPresetHost(currentHost);
            setCustomAreaVisible(keepCustom);
            renderOptions();
            $customInput.value = keepCustom ? currentHost : '';
            resetCustomHint();
        }

        // 下拉框切换：预设项立即写入设置，选"自定义 CDN"则展开输入框等待填写
        async function handleSelectChange(value) {
            if (value === CDN_CUSTOM_VALUE) {
                setCustomAreaVisible(true, true);
                renderOptions();
                // 已保存的是自定义域名时回填，方便在原有基础上修改
                if ($customInput) {
                    $customInput.value = isCustomHost(currentHost) ? currentHost : '';
                    $customInput.select();
                }
                resetCustomHint();
                return;
            }

            const saved = await window.electronAPI.invoke(options.setChannel, value);
            currentHost = saved || '';
            setCustomAreaVisible(false);
            renderOptions();
            if ($customInput) {
                $customInput.value = '';
            }
            resetCustomHint();
        }

        if ($select) {
            $select.addEventListener('change', (event) => {
                handleSelectChange(event.target.value);
            });
        }

        if ($customSaveBtn) {
            $customSaveBtn.addEventListener('click', () => {
                saveCustomHost();
            });
        }

        if ($customCancelBtn) {
            $customCancelBtn.addEventListener('click', cancelCustomHost);
        }

        // 输入框内回车直接保存、Esc 取消，保持与常见表单一致的交互
        if ($customInput) {
            $customInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    saveCustomHost();
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelCustomHost();
                }
            });
        }

        return { load };
    }

    // 拉取一次远端 CDN 列表，两组下拉框共用
    async function loadCdnList() {
        currentCdnList = await window.electronAPI.invoke('getCdnList');
        await Promise.all([
            cdnDownloadGroup.load(),
            cdnPlayGroup.load(),
        ]);
    }

    async function loadPreviewMultiThread() {
        if (!$previewMultiThreadCheckbox) return;
        const enabled = await window.electronAPI.invoke('getPreviewMultiThreadEnabled');
        $previewMultiThreadCheckbox.checked = enabled !== false;
    }

    function updateAssSettingsVisibility() {
        $assSubtitleSettings.classList.toggle('hidden', $subtitleFormatSelect.value !== 'ass');
    }

    async function loadSubtitleSettings() {
        const settings = await window.electronAPI.invoke('getSubtitleSettings');
        if (!settings) return;

        $subtitleFormatSelect.value = settings.format || 'srt';
        $subtitleAppendLanguage.checked = settings.appendLanguage === true;
        for (const input of $assOptionInputs) {
            const value = settings.assOptions?.[input.dataset.assOption];
            if (input.type === 'checkbox') {
                input.checked = value === true;
            } else if (value !== undefined && value !== null) {
                input.value = String(value);
            }
        }
        updateAssSettingsVisibility();
    }

    function getSubtitleSettingsFromForm() {
        const assOptions = {};
        for (const input of $assOptionInputs) {
            assOptions[input.dataset.assOption] = input.type === 'checkbox'
                ? input.checked
                : input.type === 'number'
                    ? Number(input.value)
                    : input.value;
        }
        return {
            format: $subtitleFormatSelect.value,
            appendLanguage: $subtitleAppendLanguage.checked,
            assOptions
        };
    }

    function saveSubtitleSettings() {
        return window.electronAPI.invoke('setSubtitleSettings', getSubtitleSettingsFromForm());
    }

    function updateDanmakuAssSettingsVisibility() {
        const anyConversion = $danmakuConvertToAss.checked === true || $danmakuConvertStandalone.checked === true;
        $danmakuAssSettings.classList.toggle('hidden', !anyConversion);
    }

    async function loadDanmakuSettings() {
        const settings = await window.electronAPI.invoke('getDanmakuSettings');
        if (!settings) return;

        $danmakuConvertToAss.checked = settings.convertToAss === true;
        $danmakuConvertStandalone.checked = settings.convertStandalone === true;
        $danmakuKeepXml.checked = settings.keepXml !== false;

        const assOptions = settings.assOptions || {};
        for (const input of $danmakuOptionInputs) {
            const value = assOptions[input.dataset.danmakuOption];
            if (input.type === 'checkbox') {
                input.checked = value === true;
            } else if (input.dataset.danmakuOption === 'blockModes') {
                input.value = Array.isArray(value) ? value.join(',') : '';
            } else if (input.dataset.danmakuOption === 'blockRegex') {
                input.value = value || '';
            } else if (value !== undefined && value !== null) {
                input.value = String(value);
            }
        }
        updateDanmakuAssSettingsVisibility();
    }

    function getDanmakuSettingsFromForm() {
        const assOptions = {};
        for (const input of $danmakuOptionInputs) {
            const key = input.dataset.danmakuOption;
            if (input.type === 'checkbox') {
                assOptions[key] = input.checked;
            } else if (key === 'blockModes') {
                assOptions[key] = input.value
                    .split(',')
                    .map(part => Number(part.trim()))
                    .filter(Number.isFinite);
            } else if (key === 'blockRegex') {
                assOptions[key] = input.value.trim();
            } else if (input.type === 'number') {
                assOptions[key] = Number(input.value);
            } else {
                assOptions[key] = input.value;
            }
        }
        return {
            convertToAss: $danmakuConvertToAss.checked,
            convertStandalone: $danmakuConvertStandalone.checked,
            keepXml: $danmakuKeepXml.checked,
            assOptions
        };
    }

    function saveDanmakuSettings() {
        return window.electronAPI.invoke('setDanmakuSettings', getDanmakuSettingsFromForm());
    }

    function selectSettingTab(tabId) {
        document.querySelectorAll('[data-setting-tab]').forEach(button => {
            const isActive = button.dataset.settingTab === tabId;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
        });
        document.querySelectorAll('.setting-tab-panel').forEach(panel => {
            panel.classList.toggle('hidden', panel.id !== tabId);
        });
    }

    document.querySelectorAll('[data-setting-tab]').forEach(button => {
        button.addEventListener('click', () => selectSettingTab(button.dataset.settingTab));
    });

    $subtitleFormatSelect.addEventListener('change', () => {
        updateAssSettingsVisibility();
        saveSubtitleSettings();
    });
    $subtitleAppendLanguage.addEventListener('change', saveSubtitleSettings);
    $assOptionInputs.forEach(input => input.addEventListener('change', saveSubtitleSettings));

    $danmakuConvertToAss.addEventListener('change', () => {
        updateDanmakuAssSettingsVisibility();
        saveDanmakuSettings();
    });
    $danmakuConvertStandalone.addEventListener('change', () => {
        updateDanmakuAssSettingsVisibility();
        saveDanmakuSettings();
    });
    $danmakuKeepXml.addEventListener('change', saveDanmakuSettings);
    $danmakuOptionInputs.forEach(input => input.addEventListener('change', saveDanmakuSettings));

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
        updateConcurrencyVisibility();
    });

    if ($concurrencySelect) {
        $concurrencySelect.addEventListener('change', (event) => {
            window.electronAPI.invoke('setConcurrency', event.target.value);
        });
    }

    if ($nodeResumeCheckbox) {
        $nodeResumeCheckbox.addEventListener('change', (event) => {
            window.electronAPI.invoke('setNodeResumeEnabled', event.target.checked);
        });
    }

    if ($danmuDownloadMethodSelect) {
        $danmuDownloadMethodSelect.addEventListener('change', (event) => {
            const selectedMethod = event.target.value;
            window.electronAPI.invoke('setDanmuDownloadMethod', selectedMethod);
        });
    }

    if ($themeSelect) {
        $themeSelect.addEventListener('change', (event) => {
            // 主进程改写 nativeTheme.themeSource，CSS 的 light-dark() 随即整体切换
            window.electronAPI.invoke('setTheme', event.target.value);
        });
    }

    if ($modalMorphCheckbox) {
        $modalMorphCheckbox.addEventListener('change', (event) => {
            // 立即生效，包括当前设置弹窗本身的关闭动画
            setModalMorphEnabled(event.target.checked);
            window.electronAPI.invoke('setModalMorphEnabled', event.target.checked);
        });
    }

    if ($selectDownloadPathBtn) {
        $selectDownloadPathBtn.addEventListener('click', selectDownloadPath);
    }

    if ($downloadInFolderCheckbox) {
        $downloadInFolderCheckbox.addEventListener('change', (event) => {
            window.electronAPI.invoke('setDownloadInFolder', event.target.checked);
            updateNestingVisibility();
        });
    }

    if ($downloadFolderNestingCheckbox) {
        $downloadFolderNestingCheckbox.addEventListener('change', (event) => {
            window.electronAPI.invoke('setDownloadFolderNesting', event.target.checked);
        });
    }

    if ($previewMultiThreadCheckbox) {
        $previewMultiThreadCheckbox.addEventListener('change', (event) => {
            window.electronAPI.invoke('setPreviewMultiThreadEnabled', event.target.checked);
        });
    }

    if ($outputFormatSelect) {
        $outputFormatSelect.addEventListener('change', (event) => {
            window.electronAPI.invoke('setOutputFormat', event.target.value);
            updateMp4NonStandardAudioVisibility();
        });
    }

    if ($mp4NonStandardAudioCheckbox) {
        $mp4NonStandardAudioCheckbox.addEventListener('change', (event) => {
            window.electronAPI.invoke('setMp4AllowNonStandardAudio', event.target.checked);
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