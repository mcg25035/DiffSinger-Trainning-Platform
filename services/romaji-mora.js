// 羅馬拼音 → mora 切分(whitespace split)
// 設計:切分/消歧只發生在「一開始的漢字+羅馬輸入」(mms romanizer)與「消歧預覽」
// (frontend MoraeInput,規則來自 dictionary initLyricsRules)。到達這裡的文字
// 已保證是空白分隔的 valid phoneme token(dictionary/jp-romanji.json),
// 所以這裡只做 whitespace split,沒有 trie。
// ASR 側的粗辨識由 sensevoice 端 kana→romaji 資料表轉成 morae(同 whitespace 格式)。

/**
 * @param {string} text 空白分隔的 mora token(或一般 romaji,此時不保證切好)
 * @returns {string[]} token 陣列
 */
function splitRomajiToMorae(text) {
    return String(text)
        .split(/\s+/)
        .map(t => t.replace(/[^\w]/g, ''))
        .filter(Boolean);
}

module.exports = { splitRomajiToMorae };
