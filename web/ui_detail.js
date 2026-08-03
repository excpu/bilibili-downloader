// UI 细节交互脚本

const $suffix = document.getElementById('suffix');
// 工具弹窗相关内容
const $toolModel = document.getElementById('model');
const $toolModelTitle = document.getElementById('modelTitle');
const $toolModelBody = document.getElementById('modelBody');
const $toolModelCloseBtn = document.getElementById('modelCloseBtn');


// 更多工具功能
const moreTools = [
    { key: 'multi-part-playback', title: '分P连续播放', description: '有些视频会切片分P上传以过审,用这个工具像观看完整的视频那样观看他们' },
    { key: 'dd-monitor', title: 'DD监控室', description: '像监控一样一次性观看多个直播间' },
];

// 触发事件
function triggerMoreToolEvent(tool) {
    console.log(tool);
    alert("暂未实现");
}

function renderMoreTools() {
    if (!$toolModelBody) {
        return;
    }

    $toolModelBody.innerHTML = `
        <div class="tool-grid">
            ${moreTools.map((tool) => `
                <div class="tool-slot" data-tool-key="${tool.key}" role="button" tabindex="0">
                    <div class="tool-slot-title">${tool.title}</div>
                    <div class="tool-slot-meta">${tool.description}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function handleMoreToolActivate(target) {
    const toolKey = target?.dataset?.toolKey;
    const tool = moreTools.find((item) => item.key === toolKey);

    if (!tool) {
        return;
    }

    triggerMoreToolEvent(tool);
}

function openToolModel(title) {
    if (!$toolModel) {
        return;
    }

    if ($toolModelTitle) {
        $toolModelTitle.textContent = title;
    }

    renderMoreTools();
    $toolModel.classList.remove('hidden');
}

function closeToolModel() {
    if ($toolModel) {
        $toolModel.classList.add('hidden');
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

function openMoreTools() {
    openToolModel('更多工具');
}

