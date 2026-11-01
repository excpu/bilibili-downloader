// file-reader.js
// 输入读取抽象：以"随机读取"方式访问媒体文件，或用一个 Buffer 冒充读取器。
//
// 解封装层（demux-m4s.js）与 M4A 转封装（m4a.js）都只依赖这个极小的接口
// { size, read(offset, length), close() }，因此两者可以共用同一份实现，
// 也便于把"按需读取、不把整段媒体放进内存"这一约束统一在一处。
'use strict';

const fs = require('fs');

/**
 * 以随机读取方式访问输入文件。
 *
 * read() 会一直重试直到读满请求的字节数，读不满即视为文件被截断并抛错，
 * 调用方不需要自己处理短读（short read）。
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {string} [options.errorLabel] 报错文案的开头，需自带"失败"二字，
 *   默认 "读取输入失败"；解封装层传 "读取 Sample 失败" 以保留原有提示语
 * @returns {{
 *   filePath: string,
 *   size: number,
 *   closed: boolean,
 *   read: (offset: number, length: number) => Buffer,
 *   close: () => void,
 * }}
 */
function createFileReader(filePath, options = {}) {
    const rawLabel = options.errorLabel || '读取输入';
    // 允许调用方传带或不带"失败"的文案，避免出现"读取 Sample 失败失败"
    const errorLabel = rawLabel.endsWith('失败') ? rawLabel : `${rawLabel}失败`;
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    let closed = false;

    return {
        filePath,
        size,

        get closed() {
            return closed;
        },

        read(offset, length) {
            if (closed) {
                throw new Error(`${errorLabel} (${filePath} @${offset})：文件已关闭`);
            }
            if (!Number.isInteger(offset) || offset < 0) {
                throw new Error(`${errorLabel} (${filePath} @${offset})：读取偏移量无效`);
            }
            if (offset + length > size) {
                throw new Error(
                    `${errorLabel} (${filePath} @${offset})：读取范围超出文件末尾 ` +
                        `(需要 ${length} 字节，文件共 ${size} 字节)`
                );
            }
            if (length <= 0) return Buffer.alloc(0);
            const buf = Buffer.allocUnsafe(length);
            let filled = 0;
            while (filled < length) {
                const got = fs.readSync(fd, buf, filled, length - filled, offset + filled);
                if (got <= 0) {
                    throw new Error(
                        `${errorLabel} (${filePath} @${offset + filled})：文件可能已被截断`
                    );
                }
                filled += got;
            }
            return buf;
        },

        close() {
            if (closed) return;
            closed = true;
            try {
                fs.closeSync(fd);
            } catch (_) {
                // 忽略重复关闭
            }
        },
    };
}

/**
 * 用 Buffer 冒充读取器，供内存输入复用同一套解析/封装逻辑
 *
 * 与 createFileReader 一样做严格的边界检查：越界读取直接抛错而不是
 * 返回一个短 Buffer，否则短读会一路传到封装层产出损坏的文件。
 * @param {Buffer|Uint8Array} buffer
 * @returns {{ size: number, closed: boolean, read: Function, close: Function }}
 */
function createBufferReader(buffer) {
    return {
        size: buffer.length,
        closed: false,
        read(offset, length) {
            if (length <= 0) return buffer.subarray(offset, offset);
            if (!Number.isInteger(offset) || offset < 0 || offset + length > buffer.length) {
                throw new Error(
                    `读取数据失败 (@${offset})：读取范围超出缓冲区末尾 ` +
                        `(需要 ${length} 字节，缓冲区共 ${buffer.length} 字节)`
                );
            }
            return buffer.subarray(offset, offset + length);
        },
        close() {},
    };
}

module.exports = { createFileReader, createBufferReader };
