// 羅馬拼音 token 的 Trie/FSM 解析引擎(唯一一份;規則參數來自 dictionary 的 initLyricsRules)
// 給 MoraeInput 校錯/建議用。與 mms romanizer.py 的 enumerate_romaji_parses 同規則:
//   1. onset + (y?)V → ka/kya/sha…(n+母音 = 保守結合,先試)
//   2. 純母音        → a/i/u/e/o
//   3. n → 撥音      → 與 1 在「n+母音/y」處形成歧義(兩條都走)
//   4. 子音無母音可接 → 促音(geminate token,預設 'cl';kka → cl+ka、utta → u+cl+ta)

const ONSETS = ["sh", "ch", "ts", ..."bcdfghjklmnprstvwzy"];
const VOWELS = "aiueo";
const ALIASES = {
    sya: "sha", syu: "shu", syo: "sho",
    zya: "ja", zyu: "ju", zyo: "jo",
    jya: "ja", jyu: "ju", jyo: "jo",
    tya: "cha", tyu: "chu", tyo: "cho",
    cya: "cha", cyu: "chu", cyo: "cho",
    si: "shi", ti: "chi", tu: "tsu", hu: "fu",
    di: "ji", du: "zu", dyu: "ju",
};
const alias = (s) => ALIASES[s] || s;

/**
 * 一個 token 的所有可能 parse(保守解在前;唯一 parse = 無歧義)
 * @param {string} w 清理過的小寫 token
 * @param {string} geminate 促音 token(來自 dictionary rules 的 insert)
 * @returns {string[][]}
 */
function enumerateParses(w, geminate = 'cl', maxParses = 8) {
    const parses = [];
    function dfs(i, acc) {
        if (parses.length >= maxParses) return;
        if (i === w.length) { parses.push(acc.slice()); return; }
        const c = w[i];
        let matched = false;
        for (const on of ONSETS) {
            if (!w.startsWith(on, i)) continue;
            const j = i + on.length;
            if (j >= w.length) break;
            if (w[j] === 'y' && VOWELS.includes(w[j + 1])) {
                matched = true;
                acc.push(alias(on + 'y' + w[j + 1])); dfs(j + 2, acc); acc.pop();
            }
            if (VOWELS.includes(w[j])) {
                matched = true;
                acc.push(alias(on + w[j])); dfs(j + 1, acc); acc.pop();
            }
        }
        if (VOWELS.includes(c)) {
            matched = true;
            acc.push(c); dfs(i + 1, acc); acc.pop();
        }
        if (c === 'n') {
            acc.push('n'); dfs(i + 1, acc); acc.pop();
        }
        if (!matched && !VOWELS.includes(c) && c !== 'n') {
            acc.push(geminate); dfs(i + 1, acc); acc.pop();
        }
    }
    dfs(0, []);
    return parses;
}

export { enumerateParses, ALIASES, ONSETS, VOWELS };
