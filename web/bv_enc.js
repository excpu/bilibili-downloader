// //https://www.zhihu.com/question/381784377/answer/1099438784
// // 原表
// const table = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';

// // 建立反查表
// const tr = {};
// for (let i = 0; i < 58; i++) {
//     tr[table[i]] = i;
// }

// const s = [11, 10, 3, 8, 4, 6];
// const xor = 177451812;
// const add = 8728348608;

// // function bvdec(x) {
// //     let r = 0;
// //     for (let i = 0; i < 6; i++) {
// //         r += tr[x[s[i]]] * 58 ** i;
// //     }
// //     return (r - add) ^ xor;
// // }

// function bvenc(x) {
//     x = (x ^ xor) + add;
//     const r = Array.from('BV1  4 1 7  ');
//     for (let i = 0; i < 6; i++) {
//         r[s[i]] = table[Math.floor(x / 58 ** i) % 58];
//     }
//     return r.join('');
// }

function bvEnc() {
    const XOR_CODE = 23442827791579n;
    const MAX_AID = 1n << 51n;
    const ALPHABET = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
    const ENCODE_MAP = [8, 7, 0, 5, 1, 3, 2, 4, 6];
    const BASE = BigInt(ALPHABET.length);

    function av2bv(aid) {
        aid = BigInt(aid);
        const chars = new Array(9);
        let tmp = (MAX_AID | aid) ^ XOR_CODE;

        for (let i = 0; i < 9; i++) {
            chars[ENCODE_MAP[i]] = ALPHABET[Number(tmp % BASE)];
            tmp /= BASE;
        }

        return "BV1" + chars.join("");
    }

    return av2bv;
}
