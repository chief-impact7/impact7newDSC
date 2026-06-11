// @impact7/shared의 package.json spec(git 태그)과 package-lock.json에 고정된
// 버전이 일치하는지 검증. 수동으로 package.json만 고치고 npm install을 돌리면
// npm이 git spec 변경을 감지하지 못해 lock이 옛 커밋을 유지한다 (조용한 drift).
// 갱신은 반드시: npm install "@impact7/shared@github:chief-impact7/impact7-shared#vX.Y.Z"
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

const spec = pkg.dependencies?.['@impact7/shared'] || '';
const specVersion = (spec.match(/#v(\d+\.\d+\.\d+)$/) || [])[1];
const lockVersion = lock.packages?.['node_modules/@impact7/shared']?.version;

if (!specVersion || !lockVersion) {
    console.error(`[shared-lock-sync] 파싱 실패 — spec: "${spec}", lock version: "${lockVersion}"`);
    process.exit(1);
}
if (specVersion !== lockVersion) {
    console.error(`[shared-lock-sync] 불일치! package.json은 v${specVersion}인데 lock은 ${lockVersion} 커밋을 고정 중.`);
    console.error(`  해결: npm install "@impact7/shared@github:chief-impact7/impact7-shared#v${specVersion}"`);
    process.exit(1);
}
console.log(`✅ @impact7/shared spec(v${specVersion}) ↔ lock(${lockVersion}) 일치`);
