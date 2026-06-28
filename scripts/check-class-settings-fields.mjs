/**
 * class_settings 필드 동기화 검증
 *
 * firestore.rules의 hasOnlyAllowedClassSettingsFields() 허용 목록과
 * JS 코드에서 saveClassSettings()로 실제 저장하는 필드를 비교한다.
 * JS에 있는데 rules에 없는 필드가 있으면 exit 1로 push를 차단한다.
 *
 * 동적 키([field], [scheduleKey]) 패턴은 정적 분석이 불가하므로
 * KNOWN_DYNAMIC_FIELDS 목록으로 별도 관리한다. 새 동적 필드 추가 시
 * 이 목록과 rules 양쪽을 함께 업데이트해야 한다.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;

// 동적 키 패턴 ({ [varName]: value }) 으로 저장되는 필드 — 수동 관리
const KNOWN_DYNAMIC_FIELDS = new Set([
    'schedule',       // _classScheduleKey() → 'schedule' | 'free_schedule'
    'free_schedule',  // _classScheduleKey() → 'schedule' | 'free_schedule'
    'free_start',     // saveFreeSemesterPeriod(classCode, 'free_start', ...)
    'free_end',       // saveFreeSemesterPeriod(classCode, 'free_end', ...)
    'special_start',  // saveTeukangPeriod(classCode, 'special_start', ...)
    'special_end',    // saveTeukangPeriod(classCode, 'special_end', ...)
    'naesin_start',   // saveClassSettings(classCode, { [field]: value })
    'naesin_end',     // saveClassSettings(classCode, { [field]: value })
    'class_type',     // saveClassSettings(classCode, { [field]: value })
    'fee_type',       // saveClassSettings(classCode, { [field]: value })
]);

// ── 1. firestore.rules에서 허용 필드 파싱 ──────────────────────────────────
const rulesPath = join(ROOT, 'firestore.rules');
const rulesText = readFileSync(rulesPath, 'utf8');

const fnMatch = rulesText.match(
    /function hasOnlyAllowedClassSettingsFields\(\)[\s\S]+?hasOnly\(\[([\s\S]+?)\]\)/
);
if (!fnMatch) {
    console.error('ERROR: firestore.rules에서 hasOnlyAllowedClassSettingsFields를 찾을 수 없습니다.');
    process.exit(1);
}
const rulesFields = new Set(
    [...fnMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
);

// ── 2. JS 파일에서 saveClassSettings 정적 필드 추출 ───────────────────────
const jsFiles = readdirSync(ROOT)
    .filter(f => f.endsWith('.js') && !f.startsWith('.'))
    .map(f => join(ROOT, f));

// saveClassSettings 정의/호출의 옵션 인자 키 무시 (Firestore 필드 아님)
// merge: 과거 setDoc 옵션 / replace: saveClassSettings 3번째 옵션 인자 { replace }
const IGNORE_KEYS = new Set(['merge', 'merged', 'replace']);

const staticFields = new Set();

for (const filePath of jsFiles) {
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('saveClassSettings(')) continue;
        // 함수 정의 라인(export async function saveClassSettings)은 스킵
        if (/function\s+saveClassSettings/.test(line)) continue;
        // saveClassSettings(...) 호출 인자만 추출한다. 호출 괄호를 균형 매칭해,
        // 뒤따르는 무관한 객체 리터럴(예: _propagateEnrollmentChange({ matcher: ... }))의
        // 키가 class_settings 필드로 오탐되는 것을 막는다.
        const chunk = lines.slice(i, i + 8).join('\n');
        const callIdx = chunk.indexOf('saveClassSettings(');
        let depth = 0, end = chunk.length;
        for (let j = callIdx + 'saveClassSettings'.length; j < chunk.length; j++) {
            if (chunk[j] === '(') depth++;
            else if (chunk[j] === ')') { depth--; if (depth === 0) { end = j + 1; break; } }
        }
        const callText = chunk.slice(callIdx, end);
        // { staticKey: ... } 패턴 — 동적 [varName] 제외, Firestore 옵션 키 제외
        const matches = [...callText.matchAll(/\{\s*([a-z_]+)\s*:/g)];
        for (const m of matches) {
            if (!IGNORE_KEYS.has(m[1])) staticFields.add(m[1]);
        }
    }
}

// ── 3. 검증 ───────────────────────────────────────────────────────────────
const allUsedFields = new Set([...staticFields, ...KNOWN_DYNAMIC_FIELDS]);
const missingInRules = [...allUsedFields].filter(f => !rulesFields.has(f)).sort();

let exitCode = 0;

if (missingInRules.length > 0) {
    console.error('\n❌ class_settings 필드 동기화 오류');
    console.error('다음 필드가 JS 코드에서 saveClassSettings()로 저장되지만');
    console.error('firestore.rules의 hasOnlyAllowedClassSettingsFields()에 없습니다:\n');
    missingInRules.forEach(f => console.error(`  - '${f}'`));
    console.error('\n수정 방법:');
    console.error('  firestore.rules의 hasOnlyAllowedClassSettingsFields() 허용 목록에 위 필드를 추가하세요.');
    console.error('  동적 필드([varName] 패턴)라면 이 스크립트의 KNOWN_DYNAMIC_FIELDS에도 추가하세요.\n');
    exitCode = 1;
}

if (exitCode === 0) {
    console.log(`✅ class_settings 필드 동기화 OK (JS ${allUsedFields.size}개 ⊆ rules ${rulesFields.size}개)`);
}

process.exit(exitCode);
