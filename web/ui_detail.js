// UI 细节交互脚本

const $suffix = document.getElementById('suffix');
// 工具弹窗相关内容
const $toolModel = document.getElementById('model');
const $toolModelTitle = document.getElementById('modelTitle');
const $toolModelBody = document.getElementById('modelBody');
const $toolModelCloseBtn = document.getElementById('modelCloseBtn');


// 工具箱内容
const toolboxTools = [
    { key: 'player', icon: '▶', title: '弹幕播放器', description: '选择下载好的 XML 弹幕与视频，在本地带弹幕播放' },
    { key: 'merge-tool', icon: '⛓', title: '缓存合并工具', description: '批量合并本地缓存的音视频分片，并按标题重命名' },
    { key: 'multi-part-playback', icon: '≣', title: '分P连续播放', description: '有些视频会切片分P上传以过审，用这个工具像观看完整的视频那样观看它们' },
    { key: 'dd-monitor', icon: '▦', title: 'DD监控室', description: '像监控一样一次性观看多个直播间，支持实时弹幕' },
];

// 触发事件
function triggerMoreToolEvent(tool) {
    console.log(tool);
    // 已实现的工具直接走各自的打开逻辑，其余仍为占位
    if (tool.key === 'player') {
        openPlayer();
        return;
    }
    if (tool.key === 'merge-tool') {
        openMergeTool();
        return;
    }
    if (tool.key === 'multi-part-playback') {
        window.electronAPI.invoke('openMultiPlayer');
        return;
    }
    if (tool.key === 'dd-monitor') {
        window.electronAPI.invoke('openMonitor').then((res) => {
            if (res && res.success === false) {
                alert(res.message || '打开 DD 监控室失败');
            }
        });
        return;
    }
    alert("暂未实现");
}

function renderMoreTools() {
    if (!$toolModelBody) {
        return;
    }

    $toolModelBody.innerHTML = `
        <div class="tool-grid">
            ${toolboxTools.map((tool) => `
                <div class="tool-slot${tool.planned ? ' is-planned' : ''}" data-tool-key="${tool.key}" role="button" tabindex="0">
                    <div class="tool-slot-icon" aria-hidden="true">${tool.icon}</div>
                    <div class="tool-slot-title">${tool.title}${tool.planned ? '<span class="tool-slot-badge">即将推出</span>' : ''}</div>
                    <div class="tool-slot-meta">${tool.description}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function handleMoreToolActivate(target) {
    const toolKey = target?.dataset?.toolKey;
    const tool = toolboxTools.find((item) => item.key === toolKey);

    if (!tool) {
        return;
    }

    // 工具箱相当于启动器：选中后就收起，避免挡住新打开的窗口
    closeToolModel();
    triggerMoreToolEvent(tool);
}

function openToolModel(title, trigger) {
    if (!$toolModel) {
        return;
    }

    if ($toolModelTitle) {
        $toolModelTitle.textContent = title;
    }

    renderMoreTools();
    // 传入触发控件，弹窗才能播放“从工具箱按钮展开、收回按钮”的动效
    openModal($toolModel, trigger);
}

function closeToolModel() {
    if ($toolModel) {
        closeModal($toolModel);
    }
}

if ($toolModelCloseBtn) {
    $toolModelCloseBtn.addEventListener('click', closeToolModel);
}

if ($toolModel) {
    $toolModel.addEventListener('click', (event) => {
        if (event.target === $toolModel) {
            closeToolModel();
        }
    });
}

if ($toolModelBody) {
    $toolModelBody.addEventListener('click', (event) => {
        const toolSlot = event.target.closest('.tool-slot');
        if (toolSlot) {
            handleMoreToolActivate(toolSlot);
        }
    });

    $toolModelBody.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        const toolSlot = event.target.closest('.tool-slot');
        if (toolSlot) {
            event.preventDefault();
            handleMoreToolActivate(toolSlot);
        }
    });
}
// ---------------------- 工具弹窗内容结束--------------------------------------
// 输入框内容变化时更新后缀显示
function input_identifier(input) {
    const value = input.trim();
    if (value.startsWith('BV') || value.startsWith('bv')) {
        $suffix.textContent = 'BV';
    } else if (value.startsWith('av') || value.startsWith('AV')) {
        $suffix.textContent = 'AV';
    } else if (value.startsWith('http://') || value.startsWith('https://')) {
        $suffix.textContent = 'URL';
    } else if (value.startsWith('ep') || value.startsWith('ss')) {
        $suffix.textContent = 'ERR';
    } else {
        $suffix.textContent = '';
    }
}


document.getElementById('urlInput').addEventListener('input', (event) => {
    input_identifier(event.target.value);
});

function openPlayer() {
    window.electronAPI.invoke('openPlayer');
}

function openMergeTool() {
    window.electronAPI.invoke('openMergeTool');
}

function openToolbox(trigger) {
    openToolModel('工具箱', trigger);
}
