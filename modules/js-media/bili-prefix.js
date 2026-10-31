// bili-prefix.js
// Bilibili PC 客户端缓存的 .m4s 文件头带 9 个 ASCII '0' (0x30) 混淆字节，
// 解析前必须跳过。此前这段判断在 demux-m4s.js（两处）和 m4a.js（一处）各写了一遍，
// 集中到这里后三种访问方式（Buffer / 文件描述符 / reader）共用同一份常量与判定。
'use strict';

const fs = require('fs');

const PREFIX_LENGTH = 9;
const PREFIX_BYTE = 0x30; // '0'

/** 已知的字节序列开头是否为 B 站前缀 */
function matchesPrefix(buf) {
    if (!buf || buf.length < PREFIX_LENGTH) return false;
    for (let i = 0; i < PREFIX_LENGTH; i++) {
        if (buf[i] !== PREFIX_BYTE) return false;
    }
    return true;
}

/**
 * 判断一段字节开头是否是 Bilibili 的 9 字节 '0' 前缀
 * @param {Buffer|Uint8Array|null} buf
 * @returns {number} 需要跳过的字节数
 */
function detectPrefixInBuffer(buf) {
    if (!buf || buf.length <= PREFIX_LENGTH) return 0;
    return matchesPrefix(buf) ? PREFIX_LENGTH : 0;
}

/**
 * 用读取器探测前缀（只读文件头 9 字节，不加载整个文件）
 * @param {{ size: number, read: (offset: number, length: number) => Buffer }} reader
 * @returns {number} 需要跳过的字节数
 */
function detectPrefixInReader(reader) {
    if (!reader || reader.size <= PREFIX_LENGTH) return 0;
    let head;
    try {
        head = reader.read(0, PREFIX_LENGTH);
    } catch (_) {
        return 0;
    }
    return matchesPrefix(head) ? PREFIX_LENGTH : 0;
}

/**
 * 用文件描述符探测前缀
 * @param {number} fd
 * @param {number} fileSize
 * @returns {number} 需要跳过的字节数
 */
function detectPrefixInFd(fd, fileSize) {
    if (fileSize <= PREFIX_LENGTH) return 0;
    const head = Buffer.allocUnsafe(PREFIX_LENGTH);
    const read = require('fs').readSync(fd, head, 0, PREFIX_LENGTH, 0);
    if (read !== PREFIX_LENGTH) return 0;
    return matchesPrefix(head) ? PREFIX_LENGTH : 0;
}

module.exports = {
    PREFIX_LENGTH,
    PREFIX_BYTE,
    matchesPrefix,
    detectPrefixInBuffer,
    detectPrefixInReader,
    detectPrefixInFd,
};
