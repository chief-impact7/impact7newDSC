// ─── Test Management Module ────────────────────────────────────────────────
// daily-ops.js에서 추출한 테스트 관리 관련 함수
// Phase 3-5

import { state, DEFAULT_TEST_SECTIONS } from './state.js';
import {
    initFailActionShared, renderFailActionCard, reopenFailDomain, selectFailType,
    clearFailType, saveFailFields, saveFailAction, completeFailTask, cancelFailTask,
} from './fail-action-shared.js';

// 명시적으로 편집 요청된 item 추적 (pending이지만 폼 표시)
const _reopenedTestItems = new Set();

// ─── deps injection ─────────────────────────────────────────────────────────
let getClassDomains;

export function initTestManagementDeps(deps) {
    getClassDomains = deps.getClassDomains;
    // 공유 fail-action 엔진 deps 주입 (hw 모듈과 동일 인스턴스 — 둘 중 먼저 init되는 쪽이 설정)
    initFailActionShared({
        renderStudentDetail: deps.renderStudentDetail,
        renderListPanel: deps.renderListPanel,
        checkCanEditGrading: deps.checkCanEditGrading,
    });
}

// ─── getClassTestSections ──────────────────────────────────────────────────

export function getClassTestSections(classCode) {
    const saved = state.classSettings[classCode]?.test_sections;
    if (saved) return JSON.parse(JSON.stringify(saved));
    // 최초: 리뷰테스트를 영역숙제관리(domains) 기반으로 초기화
    const sections = JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS));
    sections['리뷰테스트'] = [...getClassDomains(classCode)];
    return sections;
}

// ─── 테스트 미통과 후속대책 (공유 fail-action 엔진의 test 바인딩) ─────────────
// hw와의 차이: pending은 폼에서 숨기고(밀린 Task로 이동) "모두 처리됨" 표시,
// 행 인라인 저장태그 없음, task에 source:'test', docId 접두 'test_', _reopenedTestItems로
// 명시적 편집요청 추적.
const TEST_CONFIG = {
    collection: 'test_fail_tasks',
    docIdPrefix: 'test_',
    actionField: 'test_fail_action',
    firstField: 'test_domains_1st',
    fieldAttr: 'data-test-field',
    datasetKey: 'testField',
    stateTasksKey: 'testFailTasks',
    titleNoun: '테스트',
    descUnit: '항목',
    cardIcon: 'quiz',
    countSuffix: '개',
    extraTaskData: { source: 'test' },
    savedTagInline: false,
    hidePendingFromForm: true,
    reopenedSet: _reopenedTestItems,
    selectFn: 'selectTestFailType',
    clearFn: 'clearTestFailType',
    saveFieldsFn: 'saveTestFailFields',
};

export function renderTestFailActionCard(studentId, testSections, t2nd, testFailAction, mode = 'default') {
    const items = Object.values(testSections).flat();
    return renderFailActionCard({ studentId, items, d2nd: t2nd, failAction: testFailAction, mode, config: TEST_CONFIG });
}
export const reopenTestFailDomain = (studentId, item) => reopenFailDomain(studentId, item, TEST_CONFIG);
export const selectTestFailType = (studentId, item, type, btnEl) => selectFailType(studentId, item, type, TEST_CONFIG);
export const clearTestFailType = (studentId, item) => clearFailType(studentId, item, TEST_CONFIG);
export const saveTestFailFields = (studentId, item, btnEl) => saveFailFields(studentId, item, btnEl, TEST_CONFIG);
export const saveTestFailAction = (studentId, testFailAction, onlyDomain) => saveFailAction(studentId, testFailAction, onlyDomain, TEST_CONFIG);
export const completeTestFailTask = (taskDocId, studentId) => completeFailTask(taskDocId, studentId, TEST_CONFIG);
export const cancelTestFailTask = (taskDocId, studentId) => cancelFailTask(taskDocId, studentId, TEST_CONFIG);
