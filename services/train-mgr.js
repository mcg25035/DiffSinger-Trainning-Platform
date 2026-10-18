// train-mgr 整合:lazy 動態 import ESM dist(平台後端是 CJS)
// repoRoot 不給 → TrainMgr 首次用時自動 clone 上游 + patch(~/.cache/train-mgr/diffsinger)
const path = require('path');

const TRAIN_MGR_DIST = process.env.TRAIN_MGR_DIST
    || path.resolve(__dirname, '..', '..', 'train-mgr', 'dist', 'index.js');

let mgrPromise = null;

async function getMgr() {
    if (!mgrPromise) {
        mgrPromise = import(TRAIN_MGR_DIST).then(m => new m.TrainMgr({}));
    }
    return mgrPromise;
}

module.exports = { getMgr, TRAIN_MGR_DIST };
