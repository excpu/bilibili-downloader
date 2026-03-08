// BV 编码函数
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
