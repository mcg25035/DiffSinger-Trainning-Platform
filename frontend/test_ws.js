const fs = require('fs');
const js = fs.readFileSync('node_modules/wavesurfer.js/dist/wavesurfer.cjs', 'utf-8');
const match = js.match(/attachShadow\({/);
console.log("Uses shadow DOM?", match !== null);
