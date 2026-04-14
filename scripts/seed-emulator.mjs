// scripts/seed-emulator.mjs
// production Firestore에서 read-only로 일부 데이터를 가져와 emulator에 import.
//
// 사전 조건:
//   1) gcloud auth application-default login (한 번만)
//   2) 별도 터미널에서 firebase emulators:start --only firestore,auth --project=impact7db
//   3) (선택) firebase emulators:export ./emulator-data 로 native format 저장
//
// 실행:
//   node scripts/seed-emulator.mjs
//
// 안전장치:
//   - production은 read만 (write 없음).
//   - emulator는 비어있는 상태에서 시작한다고 가정 (멱등성을 위해 batch.set 사용 — 같은 ID면 덮어씀).
//   - 학생 PII를 포함하므로 결과 emulator-data/는 .gitignore.

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'impact7db';
const STUDENT_LIMIT = 30;
const DAYS_BACK = 7;

// ─── Phase 1: Read from production ─────────────────────────────────────────
console.log('[seed] Phase 1: Reading from production…');
const prodApp = initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID,
}, 'prod');
const prodDb = getFirestore(prodApp);

const studentsSnap = await prodDb.collection('students')
    .where('status', '==', '재원')
    .limit(STUDENT_LIMIT)
    .get();
const students = studentsSnap.docs.map(d => ({ id: d.id, data: d.data() }));
console.log(`  students (status=재원, limit ${STUDENT_LIMIT}): ${students.length}`);

const studentIdSet = new Set(students.map(s => s.id));

const classSettingsSnap = await prodDb.collection('class_settings').get();
const classSettings = classSettingsSnap.docs.map(d => ({ id: d.id, data: d.data() }));
console.log(`  class_settings (all): ${classSettings.length}`);

const today = new Date();
const cutoff = new Date(today);
cutoff.setDate(today.getDate() - DAYS_BACK);
const cutoffStr = cutoff.toISOString().slice(0, 10);
const dailyRecordsSnap = await prodDb.collection('daily_records')
    .where('date', '>=', cutoffStr)
    .get();
const dailyRecords = dailyRecordsSnap.docs
    .filter(d => studentIdSet.has(d.data().student_id))
    .map(d => ({ id: d.id, data: d.data() }));
console.log(`  daily_records (last ${DAYS_BACK} days, our students): ${dailyRecords.length}`);

const hwTasksSnap = await prodDb.collection('hw_fail_tasks').get();
const hwTasks = hwTasksSnap.docs
    .filter(d => studentIdSet.has(d.data().student_id))
    .map(d => ({ id: d.id, data: d.data() }));
console.log(`  hw_fail_tasks (our students): ${hwTasks.length}`);

const testTasksSnap = await prodDb.collection('test_fail_tasks').get();
const testTasks = testTasksSnap.docs
    .filter(d => studentIdSet.has(d.data().student_id))
    .map(d => ({ id: d.id, data: d.data() }));
console.log(`  test_fail_tasks (our students): ${testTasks.length}`);

// teachers + 기타 메타 컬렉션은 생략 (없어도 UI 동작에 큰 지장 없음, 필요 시 추후 보강)

// ─── Phase 2: Write to emulator ────────────────────────────────────────────
console.log('[seed] Phase 2: Writing to emulator (localhost:8080)…');
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
const emuApp = initializeApp({
    projectId: PROJECT_ID,
}, 'emulator');
const emuDb = getFirestore(emuApp);

async function writeChunked(collectionName, items) {
    if (items.length === 0) {
        console.log(`  → ${collectionName}: skip (0 items)`);
        return;
    }
    const CHUNK = 400; // Firestore batch 한도 500보다 여유
    let written = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        const batch = emuDb.batch();
        for (const item of chunk) {
            batch.set(emuDb.collection(collectionName).doc(item.id), item.data);
        }
        await batch.commit();
        written += chunk.length;
    }
    console.log(`  → ${collectionName}: ${written} written`);
}

await writeChunked('students', students);
await writeChunked('class_settings', classSettings);
await writeChunked('daily_records', dailyRecords);
await writeChunked('hw_fail_tasks', hwTasks);
await writeChunked('test_fail_tasks', testTasks);

console.log('');
console.log('[seed] ✓ Done.');
console.log('       다음 단계:');
console.log('       1) emulator 터미널에서 데이터 보존하려면 종료 시 export-on-exit 사용 (재시작 시 --import=./emulator-data)');
console.log('       2) 또는 즉시 export: 새 터미널에서 `firebase emulators:export ./emulator-data --project=impact7db`');
process.exit(0);
