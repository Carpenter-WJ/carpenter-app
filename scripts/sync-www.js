// Capacitor의 webDir(www/)에 네이티브 앱이 실제로 담을 정적 파일만 복사.
// 번들러가 없는 순수 정적 앱이라, 저장소 루트 전체 대신 필요한 파일만 골라 복사한다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const FILES = ['index.html', 'style.css', 'app.js', 'pricing.js', 'manifest.json', 'icon.svg', 'sw.js'];
const DIRS = ['img'];

fs.rmSync(WWW, {recursive: true, force: true});
fs.mkdirSync(WWW, {recursive: true});

for (const f of FILES) {
  fs.copyFileSync(path.join(ROOT, f), path.join(WWW, f));
}
for (const d of DIRS) {
  fs.cpSync(path.join(ROOT, d), path.join(WWW, d), {recursive: true});
}

console.log(`www/ 동기화 완료 (${FILES.length}개 파일 + ${DIRS.join(', ')} 폴더)`);
