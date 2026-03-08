// UI 细节交互脚本

const $suffix = document.getElementById('suffix');
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
