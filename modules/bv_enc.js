//https://www.zhihu.com/question/381784377/answer/1099438784
// 原表
const table = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';

// 建立反查表
const tr = {};
for (let i = 0; i < 58; i++) {
    tr[table[i]] = i;
}

const s = [11, 10, 3, 8, 4, 6];
const xor = 177451812;
const add = 8728348608;

function dec(x) {
    let r = 0;
    for (let i = 0; i < 6; i++) {
        r += tr[x[s[i]]] * 58 ** i;
        // 如果你不想用 **，可以用 Math.pow(58, i)
    }
    return (r - add) ^ xor;
}

function enc(x) {
    x = (x ^ xor) + add;
    const r = Array.from('BV1  4 1 7  ');
    for (let i = 0; i < 6; i++) {
        r[s[i]] = table[Math.floor(x / 58 ** i) % 58];
    }
    return r.join('');
}

// 测试
console.log(dec('BV17x411w7KC'));   // 170001
console.log(dec('BV1Q541167Qg'));   // 455017605
console.log(dec('BV1mK4y1C7Bz'));   // 882584971

console.log(enc(170001));      // BV17x411w7KC
console.log(enc(455017605));   // BV1Q541167Qg
console.log(enc(882584971));   // BV1mK4y1C7Bz
