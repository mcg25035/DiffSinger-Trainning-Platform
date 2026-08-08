function mapRomajiToPhonemes(romajiStr, mapping) {
    if (!mapping || !mapping.dictionary) {
        return romajiStr;
    }
    const words = romajiStr.trim().split(/\s+/);
    const phonemes = [];

    for (const word of words) {
        if (!word) continue;
        const ipaStr = mapping.dictionary[word] || mapping.dictionary[word.toLowerCase()];
        if (ipaStr) {
            const ipaSymbols = ipaStr.split(/\s+/);
            for (const sym of ipaSymbols) {
                const mappedSym = mapping.reverse_mapping[sym] ?? sym;
                phonemes.push(mappedSym);
            }
        } else {
            // Fallback: if not in dictionary, just push individual characters
            for (const char of word) {
                phonemes.push(char.toLowerCase());
            }
        }
    }
    return phonemes.join(' ');
}

module.exports = mapRomajiToPhonemes;
