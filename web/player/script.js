const fileBtn = document.getElementById('fileBtn');
const folderBtn = document.getElementById('folderBtn');
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const selectedInfo = document.getElementById('selectedInfo');
const selectedPath = document.getElementById('selectedPath');

fileBtn.addEventListener('click', () => {
    fileInput.click();
});

folderBtn.addEventListener('click', () => {
    folderInput.click();
});

// 验证用户文件输入
function validateFiles(files) {
    const xmlFiles = files.filter(file => file.name.endsWith('.xml'));
    const mp4Files = files.filter(file => file.name.endsWith('.mp4'));

    if (xmlFiles.length === 0) return { valid: false, message: '没有XML文件！' };
    if (mp4Files.length === 0) return { valid: false, message: '没有MP4文件！' };
    if (xmlFiles.length > 1 || mp4Files.length > 1) {
        return { valid: false, message: '只能有一个XML和一个MP4文件！' };
    }

    return { valid: true, xmlFiles, mp4Files };
}


fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    const result = validateFiles(files);

    if (!result.valid) {
        alert('请选择一个XML文件！' + '请选择一个MP4文件！');
        return;
    }

    selectedPath.textContent = `${result.xmlFiles[0].name} 和 ${result.mp4Files[0].name}`;
    selectedInfo.classList.add('show');

    startPlayer(result.mp4Files[0], result.xmlFiles[0]);
});

folderInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    const result = validateFiles(files);

    if (!result.valid) {
        alert('文件夹中' + result.message);
        return;
    }

    selectedPath.textContent = `${result.xmlFiles[0].name} 和 ${result.mp4Files[0].name}`;
    selectedInfo.classList.add('show');

    startPlayer(result.mp4Files[0], result.xmlFiles[0]);
});