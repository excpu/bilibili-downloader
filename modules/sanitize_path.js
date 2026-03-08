function sanitizePath(input, replacement = '_') {
    // Windows 禁止: <>:"/\|?* 及控制字符 \x00-\x1F
    // POSIX 禁止: /
    // macOS HFS+ 禁止: :
    const illegalRegex = /[<>:"/\\|?*\x00-\x1F]/g;

    // 先替换所有非法字符
    let output = input.replace(illegalRegex, replacement);

    // macOS HFS+ 特殊：禁止 ":" 
    output = output.replace(/:/g, replacement);

    // 移除多余重复替代符号
    output = output.replace(new RegExp(`${replacement}+`, 'g'), replacement);

    // 去掉开头或结尾的替换符号
    output = output.replace(new RegExp(`^${replacement}+|${replacement}+$`, 'g'), '');

    return output;
}

module.exports = {
    sanitizePath
};