// mora 切分一致性測試
// 設計:切分 trie 只存在於 mms romanizer(初始消歧)與 frontend lib(校錯/建議);
// Node 端只做 whitespace split(輸入保證已是切好的 token)。
// 測試:1) 前端 trie 基本正確性 2) 前端 trie vs python trie 一致(慣例差 N/n 正規化)
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('path');
const { splitRomajiToMorae } = require('../services/romaji-mora');

// 前端 lib 是 ESM(frontend/package.json type:module),動態 import
let enumerateParses;
test('載入前端 trie lib', async () => {
    ({ enumerateParses } = await import(path.join('..', 'frontend', 'src', 'lib', 'romaji-mora.js') + ''));
    assert.strictEqual(typeof enumerateParses, 'function');
});

const CASES = [
    'usotte', 'gakkou', 'shinai', 'kyou', 'ho o', 'tte', 'kkou', 'kya', 'nya', 'kka',
    'do u datte i i koto wo usotte haite modore na i',
    'jikou na n te yatte ko na i ubatta yo u ni ubaware te',
    'me de boku to wakatte mo mo u daki shime na ku te ii n da yo',
    'uso tsuki datte shiru n da yo nee',
    'o i de ko ko ma de sutei',
    'ho o i ro ni a ka ne sa su hi wa ya wa ra ka ni ha ze ta',
    'sha yo u ni bo ku ra wa me mo a ka nu ma ma',
];

test('Node 端 = whitespace split(不做 trie)', () => {
    assert.deepEqual(splitRomajiToMorae('ho o i ro ni'), ['ho', 'o', 'i', 'ro', 'ni']);
    assert.deepEqual(splitRomajiToMorae('u so cl te'), ['u', 'so', 'cl', 'te']);
    assert.deepEqual(splitRomajiToMorae('  ho   o  '), ['ho', 'o']);
});

test('前端 trie 基本正確性(促音/雙子音/母音/歧義數)', () => {
    assert.deepEqual(enumerateParses('usotte')[0], ['u', 'so', 'cl', 'te']);
    assert.deepEqual(enumerateParses('kka')[0], ['cl', 'ka']);       // 雙子音 → cl+ka
    assert.deepEqual(enumerateParses('utta')[0], ['u', 'cl', 'ta']);
    assert.deepEqual(enumerateParses('tte')[0], ['cl', 'te']);
    assert.deepEqual(enumerateParses('ho')[0], ['ho']);
    assert.deepEqual(enumerateParses('shinai').length, 2);           // 歧義:紅線,不用戶強制分開
});

test('python trie 長音符號(頁面慣用 - 標長音;前端不處理,紅線自己訂正)', () => {
    const pyScript = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'microservices', 'mms_service', 'app'))})
from romanizer import romaji_to_morae, morae_to_romaji
cases = json.load(sys.stdin)
print(json.dumps([morae_to_romaji(romaji_to_morae(c)) for c in cases]))
`;
    const r = spawnSync('python3', ['-c', pyScript], {
        input: JSON.stringify(['ha-to', 'me-de-', 'nooto']), encoding: 'utf-8', timeout: 60000,
    });
    assert.strictEqual(r.status, 0, `python 執行失敗: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out[0], ['ha', 'a', 'to']);   // ha-to → は+あ+と(長音解優先)
    assert.deepEqual(out[1], ['me', 'e', 'de', 'e']); // 尾端 - 也補長音
    assert.deepEqual(out[2], ['no', 'o', 'to']);
});

test('前端 trie 與 python trie(mms romanizer)輸出一致', () => {
    const pyScript = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'microservices', 'mms_service', 'app'))})
from romanizer import romaji_to_morae, morae_to_romaji
cases = json.load(sys.stdin)
print(json.dumps([morae_to_romaji(romaji_to_morae(c)) for c in cases]))
`;
    const r = spawnSync('python3', ['-c', pyScript], {
        input: JSON.stringify(CASES), encoding: 'utf-8', timeout: 60000,
    });
    assert.strictEqual(r.status, 0, `python 執行失敗: ${r.stderr}`);
    const pyAll = JSON.parse(r.stdout);
    assert.strictEqual(pyAll.length, CASES.length);
    for (let i = 0; i < CASES.length; i++) {
        // 前端 trie 逐 token 解析(空白分隔),串起來跟 python 全域 parse 比對
        const js = CASES[i].split(/\s+/).flatMap(w => enumerateParses(w.replace(/[^\w]/g, ''))[0] ?? [])
            .map(t => (t === 'n' ? 'N' : t)); // 慣例正規化(JS 'n' ↔ py 'N')
        assert.deepEqual(js, pyAll[i], `case "${CASES[i]}": JS=${JSON.stringify(js)} vs py=${JSON.stringify(pyAll[i])}`);
    }
});
