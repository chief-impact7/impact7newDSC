#!/usr/bin/env node
/**
 * fix-enrollment-data.js
 *
 * Firestore students 컬렉션의 enrollment 데이터를 일괄 수정하는 스크립트.
 *
 * 문제: level_symbol에 숫자만 들어있는 경우 → class_number로 이동해야 함.
 *
 * 사용법:
 *   node scripts/fix-enrollment-data.js            # dry-run (변경 사항만 출력)
 *   node scripts/fix-enrollment-data.js --execute   # 실제 Firestore에 쓰기
 *
 * 서비스 계정:
 *   환경변수 GOOGLE_APPLICATION_CREDENTIALS에 서비스 계정 JSON 파일 경로 설정
 *   또는 프로젝트 루트에 service-account.json 파일 배치
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// ─── Firebase Admin 초기화 ──────────────────────────────────────────────────

function initFirebase() {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
        || resolve(projectRoot, 'service-account.json');

    if (!existsSync(credPath)) {
        console.error(`[ERROR] 서비스 계정 파일을 찾을 수 없습니다: ${credPath}`);
        console.error('  GOOGLE_APPLICATION_CREDENTIALS 환경변수를 설정하거나');
        console.error('  프로젝트 루트에 service-account.json 파일을 배치하세요.');
        process.exit(1);
    }

    const serviceAccount = JSON.parse(readFileSync(credPath, 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
    return getFirestore();
}

// ─── 숫자만 있는지 체크 ─────────────────────────────────────────────────────

function isDigitsOnly(val) {
    return typeof val === 'string' && val.length > 0 && /^\d+$/.test(val);
}

// ─── 메인 로직 ──────────────────────────────────────────────────────────────

async function main() {
    const executeMode = process.argv.includes('--execute');
    console.log(`\n=== Enrollment 데이터 수정 스크립트 ===`);
    console.log(`모드: ${executeMode ? '🔴 EXECUTE (실제 쓰기)' : '🟢 DRY-RUN (미리보기)'}\n`);

    const db = initFirebase();
    const studentsRef = db.collection('students');
    const snapshot = await studentsRef.get();

    let totalDocs = 0;
    let changedDocs = 0;
    const changes = [];

    for (const doc of snapshot.docs) {
        totalDocs++;
        const data = doc.data();
        const docId = doc.id;
        const name = data.name || '(이름없음)';

        if (data.enrollments?.length) {
            // Case 1: enrollments 배열이 있는 학생
            let modified = false;
            const updatedEnrollments = data.enrollments.map((enr, idx) => {
                const ls = enr.level_symbol || '';
                const cn = enr.class_number || '';

                if (isDigitsOnly(ls) && !cn) {
                    modified = true;
                    changes.push({
                        docId, name,
                        type: 'enrollments',
                        index: idx,
                        before: { level_symbol: ls, class_number: cn },
                        after: { level_symbol: '', class_number: ls }
                    });
                    return { ...enr, level_symbol: '', class_number: ls };
                }
                return enr;
            });

            if (modified) {
                changedDocs++;
                if (executeMode) {
                    await studentsRef.doc(docId).update({ enrollments: updatedEnrollments });
                }
            }
        } else {
            // Case 2: flat 필드만 있는 학생 (enrollments 배열 없음)
            const ls = data.level_symbol || data.level_code || '';
            const cn = data.class_number || '';

            if (isDigitsOnly(ls) && !cn) {
                changedDocs++;
                const updateData = {};

                if (data.level_symbol && isDigitsOnly(data.level_symbol)) {
                    updateData.level_symbol = '';
                    updateData.class_number = data.level_symbol;
                } else if (data.level_code && isDigitsOnly(data.level_code)) {
                    updateData.class_number = data.level_code;
                }

                changes.push({
                    docId, name,
                    type: 'flat',
                    before: { level_symbol: data.level_symbol || '', level_code: data.level_code || '', class_number: cn },
                    after: updateData
                });

                if (executeMode && Object.keys(updateData).length > 0) {
                    await studentsRef.doc(docId).update(updateData);
                }
            }
        }
    }

    // ─── 결과 출력 ─────────────────────────────────────────────────────────

    console.log('--- 변경 내역 ---\n');

    if (changes.length === 0) {
        console.log('수정이 필요한 문서가 없습니다.\n');
    } else {
        for (const c of changes) {
            console.log(`[${c.docId}] ${c.name} (${c.type}${c.index != null ? ` #${c.index}` : ''})`);
            console.log(`  BEFORE: ${JSON.stringify(c.before)}`);
            console.log(`  AFTER:  ${JSON.stringify(c.after)}`);
            console.log();
        }
    }

    console.log('--- 요약 ---');
    console.log(`전체 문서: ${totalDocs}`);
    console.log(`변경 문서: ${changedDocs}`);
    console.log(`변경 항목: ${changes.length}`);

    if (executeMode) {
        console.log('\n실제 Firestore에 변경사항이 적용되었습니다.');
    } else {
        console.log('\n(dry-run) 실제 변경 없음. --execute 플래그로 적용하세요.');
    }
}

main().catch(err => {
    console.error('[ERROR]', err);
    process.exit(1);
});
