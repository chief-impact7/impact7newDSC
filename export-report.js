// ─── 일일현황표 구글시트 다운로드 ─────────────────────────────────────────────
// daily-ops.js에서 분리 (Phase 2-2)

import { state, LEAVE_STATUSES } from './state.js';
import { getDayName } from './src/shared/firestore-helpers.js';
import { signInWithGoogle, getGoogleAccessToken } from './auth.js';
import { formatTime12h, showSaveIndicator } from './ui-utils.js';
import {
    getActiveEnrollments, matchesBranchFilter, enrollmentCode,
    allClassCodes, branchFromStudent, getStudentStartTime
} from './student-helpers.js';

// ─── 의존성 주입 (daily-ops.js에서 init 호출) ──────────────────────────────
let getStudentDomains, getStudentTestItems, getTeacherName;

export function initExportReportDeps(deps) {
    getStudentDomains = deps.getStudentDomains;
    getStudentTestItems = deps.getStudentTestItems;
    getTeacherName = deps.getTeacherName;
}

let _pickerApiLoaded = false;
function loadPickerApi() {
    return new Promise((resolve) => {
        if (_pickerApiLoaded) { resolve(); return; }
        gapi.load('picker', () => { _pickerApiLoaded = true; resolve(); });
    });
}

function pickDriveFolder() {
    return new Promise((resolve) => {
        const token = getGoogleAccessToken();
        // 내 드라이브 폴더
        const myDriveView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setOwnedByMe(true)
            .setParent('root');
        // 공유 드라이브
        const sharedDriveView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setEnableDrives(true);
        const picker = new google.picker.PickerBuilder()
            .setTitle('저장할 폴더를 선택하세요')
            .addView(myDriveView)
            .addView(sharedDriveView)
            .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
            .setOAuthToken(token)
            .setCallback((data) => {
                if (data.action === google.picker.Action.PICKED) {
                    resolve(data.docs[0].id);
                } else if (data.action === google.picker.Action.CANCEL) {
                    resolve(null);
                }
            })
            .build();
        picker.setVisible(true);
    });
}

export async function exportDailyReport() {
    let token = getGoogleAccessToken();
    if (!token) {
        if (!confirm('구글 드라이브 접근 토큰이 만료되었습니다.\n다시 로그인하시겠습니까?')) return;
        try {
            await signInWithGoogle();
            token = getGoogleAccessToken();
        } catch { return; }
        if (!token) { alert('로그인에 실패했습니다. 다시 시도해주세요.'); return; }
    }

    const dayName = getDayName(state.selectedDate);
    let students = state.allStudents.filter(s =>
        s.status !== '퇴원' &&
        getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayName))
    );
    students = students.filter(s => matchesBranchFilter(s));
    if (state.selectedClassCode) {
        students = students.filter(s =>
            getActiveEnrollments(s, state.selectedDate).some(e =>
                e.day.includes(dayName) && enrollmentCode(e) === state.selectedClassCode
            )
        );
    }

    if (students.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    // 폴더 선택
    await loadPickerApi();
    const folderId = await pickDriveFolder();
    if (!folderId) return; // 취소

    // 반별 정렬
    students.sort((a, b) => {
        const cA = allClassCodes(a)[0] || '';
        const cB = allClassCodes(b)[0] || '';
        return cA.localeCompare(cB, 'ko') || a.name.localeCompare(b.name, 'ko');
    });

    const HEADERS = [
        '반', '담당', '이름', '소속', '학교', '학년', '상태',
        '예정시간', '출결', '실제등원', '출결사유',
        '숙제1차', '숙제2차', '테스트1차', '테스트2차',
        '후속조치', '다음숙제',
        '귀가', '귀가시간',
        '수업→자습 전달', '학부모 전달'
    ];

    const formatOxMap = (domainData, domains) => {
        if (!domains?.length) return '';
        const parts = domains.map(d => domainData[d] ? `${d}:${domainData[d]}` : '').filter(Boolean);
        return parts.join(', ');
    };

    const formatActions = (hwAction, testAction, domains, testItems) => {
        const parts = [];
        const pushAction = (key, actionMap) => {
            const a = actionMap[key];
            if (!a?.type) return;
            if (a.type === '등원') parts.push(`${key}:등원 ${a.scheduled_date || ''} ${a.scheduled_time ? formatTime12h(a.scheduled_time) : ''}`);
            else if (a.type === '대체숙제') parts.push(`${key}:대체숙제 "${a.alt_hw || ''}"`);
            else parts.push(`${key}:${a.type}`);
        };
        domains.forEach(d => pushAction(d, hwAction));
        testItems.forEach(t => pushAction(t, testAction));
        return parts.join(', ');
    };

    const dataRows = students.map(s => {
        const todayEnroll = getActiveEnrollments(s, state.selectedDate).find(e => e.day.includes(dayName));
        const code = todayEnroll ? enrollmentCode(todayEnroll) : '';
        const rec = state.dailyRecords[s.docId] || {};
        const teacher = state.classSettings[code]?.teacher ? getTeacherName(state.classSettings[code].teacher) : '';
        const domains = getStudentDomains(s.docId);
        const { flat: testItems } = getStudentTestItems(s.docId);

        // 출결
        const attStatus = rec?.attendance?.status || '미확인';
        const displayAtt = attStatus === '미확인' ? '정규' : attStatus;
        const arrTime = rec?.arrival_time ? formatTime12h(rec.arrival_time) : '';
        const attReason = rec?.attendance?.reason || '';

        // 상태 (휴원이면 기간 포함)
        let statusText = s.status || '재원';
        if (LEAVE_STATUSES.includes(s.status)) {
            const p1 = s.pause_start_date || '';
            const p2 = s.pause_end_date || '';
            if (p1 || p2) statusText += ` (${p1}~${p2})`;
        }

        // 숙제/테스트 OX
        const hw1st = formatOxMap(rec.hw_domains_1st || {}, domains);
        const hw2nd = formatOxMap(rec.hw_domains_2nd || {}, domains);
        const test1st = formatOxMap(rec.test_domains_1st || {}, testItems);
        const test2nd = formatOxMap(rec.test_domains_2nd || {}, testItems);

        // 후속조치
        const actions = formatActions(rec.hw_fail_action || {}, rec.test_fail_action || {}, domains, testItems);

        // 다음숙제
        const classData = state.classNextHw[code]?.domains || {};
        const personalNh = rec.personal_next_hw || {};
        const nextHwParts = domains.map(d => {
            const pKey = `${code}_${d}`;
            const val = personalNh[pKey] != null && personalNh[pKey] !== '' ? personalNh[pKey] : (classData[d] || '');
            return val ? `${d}:${val}` : '';
        }).filter(Boolean);
        const nextHw = nextHwParts.join(', ');

        // 귀가
        const dep = rec.departure || {};
        const depStatus = dep.status === '귀가' ? '귀가' : '';
        const depTime = dep.time ? formatTime12h(dep.time) : '';

        // 전달사항
        const noteClass = rec.note_class_to_study || '';
        const noteParent = rec.note_to_parent || '';

        const startTime = getStudentStartTime(todayEnroll);
        return [
            code, teacher, s.name, branchFromStudent(s), s.school || '', s.grade || '', statusText,
            startTime ? formatTime12h(startTime) : '', displayAtt, arrTime, attReason,
            hw1st, hw2nd, test1st, test2nd,
            actions, nextHw,
            depStatus, depTime,
            noteClass, noteParent
        ];
    });

    showSaveIndicator('saving');
    try {
        const headerRow = {
            values: HEADERS.map(h => ({
                userEnteredValue: { stringValue: h },
                userEnteredFormat: {
                    textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                    backgroundColorStyle: { rgbColor: { red: 0.263, green: 0.522, blue: 0.957 } }
                }
            }))
        };
        const bodyRows = dataRows.map(row => ({
            values: row.map(cell => ({ userEnteredValue: { stringValue: String(cell) } }))
        }));

        // 1. 구글시트 생성
        const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                properties: { title: `일일현황표_${state.selectedDate}` },
                sheets: [{
                    properties: { title: '일일현황', gridProperties: { frozenRowCount: 1 } },
                    data: [{ startRow: 0, startColumn: 0, rowData: [headerRow, ...bodyRows] }]
                }]
            })
        });

        if (!createResp.ok) throw new Error(await createResp.text());
        const created = await createResp.json();
        const fileId = created.spreadsheetId;
        const sid = created.sheets[0].properties.sheetId;

        // 2. 선택한 폴더로 이동
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${folderId}&removeParents=root&supportsAllDrives=true&fields=id`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        }).catch(e => console.warn('폴더 이동 실패:', e));

        // 3. 필터 + 열 자동 맞춤
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [
                { setBasicFilter: { filter: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: dataRows.length + 1, startColumnIndex: 0, endColumnIndex: HEADERS.length } } } },
                { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: HEADERS.length } } }
            ]})
        }).catch(e => console.warn('서식 설정 실패:', e));

        showSaveIndicator('saved');
        window.open(created.spreadsheetUrl, '_blank');
    } catch (e) {
        showSaveIndicator('error');
        alert('구글시트 생성 실패: ' + e.message + '\n\n로그아웃 후 다시 로그인하면 해결될 수 있습니다.');
    }
}
