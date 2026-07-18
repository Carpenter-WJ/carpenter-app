// Firebase functions 배포는 functions/ 폴더 안의 내용만 업로드하므로,
// 저장소 루트의 pricing.js(웹/서버 공용)를 배포 직전에 functions/ 안으로 복사한다.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'pricing.js');
const dest = path.join(__dirname, '..', 'functions', 'pricing.js');

fs.copyFileSync(src, dest);
console.log(`pricing.js copied: ${src} -> ${dest}`);
