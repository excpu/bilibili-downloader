// 下载取消相关的公共工具
function createCancelError() {
    const err = new Error('下载已取消');
    err.code = 'DOWNLOAD_CANCELLED';
    err.unrecoverable = true;
    err.nonRetriable = true;
    return err;
}

function isCancelError(err) {
    return !!err && err.code === 'DOWNLOAD_CANCELLED';
}

module.exports = { createCancelError, isCancelError };
