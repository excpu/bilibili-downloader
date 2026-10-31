// stream-writer.js
// 顺序写文件的辅助封装：写满内部流缓冲时等待 drain，保证不会把整段媒体堆在内存里。
const fs = require('fs');

/**
 * 创建一个带背压处理的顺序文件写入器
 * @param {string} filePath
 * @returns {{
 *   write: (chunk: Buffer|Uint8Array) => Promise<void>,
 *   close: () => Promise<{ filePath: string, size: number, bytesWritten: number }>,
 *   abort: () => void,
 *   bytesWritten: () => number,
 * }}
 */
function createFileWriter(filePath) {
    const stream = fs.createWriteStream(filePath);
    let failure = null;
    let written = 0;

    stream.on('error', (err) => {
        if (!failure) failure = err;
    });

    const write = (chunk) => {
        if (failure) return Promise.reject(failure);
        written += chunk.length;
        // 返回 false 表示内部缓冲已满，此时必须等 drain 再继续写
        if (stream.write(chunk)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const cleanup = () => {
                stream.removeListener('drain', onDrain);
                stream.removeListener('error', onError);
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
        });
    };

    const close = async () => {
        if (failure) {
            stream.destroy();
            throw failure;
        }
        await new Promise((resolve, reject) => {
            if (stream.writableFinished) return resolve();
            stream.once('finish', resolve);
            stream.once('error', reject);
            stream.end();
        });
        if (failure) throw failure;
        return { filePath, size: fs.statSync(filePath).size, bytesWritten: written };
    };

    const abort = () => {
        stream.destroy();
    };

    return { write, close, abort, bytesWritten: () => written };
}

module.exports = { createFileWriter };