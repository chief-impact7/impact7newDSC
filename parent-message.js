// ─── 학부모 알림 메시지 생성 ────────────────────────────────────────────────
// daily-ops.js에서 분리 (Phase 2-1)

import { state } from './state.js';
import { geminiModel } from './firebase-config.js';
import { parseDateKST, getDayName } from './src/shared/firestore-helpers.js';
import { esc, decodeHtmlEntities, formatTime12h, showSaveIndicator } from './ui-utils.js';
import { enrollmentCode } from './student-helpers.js';

// ─── 의존성 주입 (daily-ops.js에서 init 호출) ──────────────────────────────
let getStudentDomains, getStudentTestItems, getStudentChecklistStatus;

export function initParentMessageDeps(deps) {
    getStudentDomains = deps.getStudentDomains;
    getStudentTestItems = deps.getStudentTestItems;
    getStudentChecklistStatus = deps.getStudentChecklistStatus;
}

// ─── 모듈 내부 변수 ────────────────────────────────────────────────────────
let parentMsgStudentId = null;
let parentMsgMode = 'ai'; // 'ai' | 'manual'

const DEFAULT_PARENT_MSG_PROMPT = `영어학원 "임팩트7" 담당 선생님이 학부모님께 보내는 총평 코멘트를 작성하세요.

규칙:
- 존댓말, 따뜻한 톤. 이모지 금지
- 인사말 없이 바로 내용 시작
- "오늘" 대신 요일로 지칭 (데이터에서 날짜 확인)
- "{name} 학생은" 으로 시작
- 개별 항목명 나열 금지 (데이터는 별도 첨부됨)
- 3-4문장, 150자 내외로 간결하게
- "감사합니다. 임팩트7"로 끝낼 것

절대 금지:
- 데이터에 없는 내용을 지어내거나 추측하지 말 것 (발표, 태도, 수업참여 등 데이터에 없으면 언급 금지)
- 숙제 데이터가 비어있으면 숙제에 대해 언급하지 말 것
- 테스트 데이터가 비어있으면 테스트에 대해 언급하지 말 것
- 출결이 "결석"이면 절대로 출석했다거나 수업을 잘 들었다고 쓰지 말 것. 결석 사실을 정확히 반영할 것
- 출결이 "지각"이면 정상 출석처럼 쓰지 말 것
- 재시, 보충, 등원 예약, 대체숙제, 후속 조치에 대해 절대 언급하지 말 것 (별도 안내됨)
- 날짜, 시간, 일정을 절대 지어내지 말 것
- 오직 제공된 학생 데이터에 존재하는 항목만 근거로 작성할 것`;

export function getCustomPrompt() {
    try {
        return localStorage.getItem('parent_msg_prompt') || DEFAULT_PARENT_MSG_PROMPT;
    } catch { return DEFAULT_PARENT_MSG_PROMPT; }
}

export function saveCustomPrompt() {
    const textarea = document.getElementById('parent-msg-prompt');
    if (textarea) {
        localStorage.setItem('parent_msg_prompt', textarea.value);
        showSaveIndicator('saved');
    }
}

export function resetPromptToDefault() {
    const textarea = document.getElementById('parent-msg-prompt');
    if (textarea) {
        textarea.value = DEFAULT_PARENT_MSG_PROMPT;
        localStorage.removeItem('parent_msg_prompt');
        showSaveIndicator('saved');
    }
}

export function togglePromptEditor() {
    const editor = document.getElementById('parent-msg-prompt-editor');
    const arrow = document.getElementById('prompt-arrow');
    if (!editor) return;
    const isHidden = editor.style.display === 'none';
    editor.style.display = isHidden ? '' : 'none';
    arrow?.classList.toggle('expanded', isHidden);
    if (isHidden) {
        const textarea = document.getElementById('parent-msg-prompt');
        if (textarea) textarea.value = getCustomPrompt();
    }
}

export function collectStudentDaySummary(studentId) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return null;

    const rec = state.dailyRecords[studentId] || {};
    const domains = getStudentDomains(studentId);
    const { flat: testItems } = getStudentTestItems(studentId);
    const checklist = getStudentChecklistStatus(studentId);

    const summary = {
        name: student.name,
        date: state.selectedDate,
        attendance: rec?.attendance?.status || '미확인',
        arrival_time: rec?.arrival_time || '',
        departure: rec?.departure || {},
        homework_1st: {},
        homework_2nd: {},
        test_1st: {},
        test_2nd: {},
        hw_fail_actions: {},
        test_fail_actions: {},
        extra_visit: rec.extra_visit || {},
        note: rec.note || '',
        checklist: checklist.map(c => `${c.label}: ${c.done ? '완료' : '미완료'}`).join(', ')
    };

    const hw1st = rec.hw_domains_1st || {};
    const hw2nd = rec.hw_domains_2nd || {};
    domains.forEach(d => {
        if (hw1st[d]) summary.homework_1st[d] = hw1st[d];
        if (hw2nd[d]) summary.homework_2nd[d] = hw2nd[d];
    });

    const t1st = rec.test_domains_1st || {};
    const t2nd = rec.test_domains_2nd || {};
    testItems.forEach(t => {
        if (t1st[t]) summary.test_1st[t] = t1st[t];
        if (t2nd[t]) summary.test_2nd[t] = t2nd[t];
    });

    // 1차 미통과 + 2차 미입력 → 자동 후속조치 항목 추가
    const chkHw1 = rec.hw_domains_1st || {};
    const chkHw2 = rec.hw_domains_2nd || {};
    domains.forEach(d => {
        if (chkHw1[d] && chkHw1[d] !== 'O' && chkHw2[d] !== 'O') {
            if (!summary.hw_fail_actions[d]) {
                summary.hw_fail_actions[d] = { type: '미통과', auto: true };
            }
        }
    });
    const chkT1 = rec.test_domains_1st || {};
    const chkT2 = rec.test_domains_2nd || {};
    testItems.forEach(t => {
        if (chkT1[t] && chkT1[t] !== 'O' && chkT2[t] !== 'O') {
            if (!summary.test_fail_actions[t]) {
                summary.test_fail_actions[t] = { type: '미통과', auto: true };
            }
        }
    });

    const hwAction = rec.hw_fail_action || {};
    Object.entries(hwAction).forEach(([d, a]) => {
        if (a.type) summary.hw_fail_actions[d] = { type: a.type, scheduled_date: a.scheduled_date, scheduled_time: a.scheduled_time, alt_hw: a.alt_hw };
    });

    const testAction = rec.test_fail_action || {};
    Object.entries(testAction).forEach(([t, a]) => {
        if (a.type) summary.test_fail_actions[t] = { type: a.type, scheduled_date: a.scheduled_date, scheduled_time: a.scheduled_time, alt_hw: a.alt_hw };
    });

    // hw_fail_tasks / test_fail_tasks 컬렉션에서 pending 태스크 보완
    // source_date(미통과 발생일) 또는 scheduled_date(등원 예정일)가 오늘인 태스크 포함
    const matchedHwTasks = state.hwFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    const matchedTestTasks = state.testFailTasks.filter(t => t.student_id === studentId && t.status === 'pending');
    matchedHwTasks.filter(t => t.source_date === state.selectedDate || t.scheduled_date === state.selectedDate).forEach(t => {
        const key = t.domain || t.type || 'etc';
        if (!summary.hw_fail_actions[key]) {
            summary.hw_fail_actions[key] = { type: t.type, scheduled_date: t.scheduled_date, scheduled_time: t.scheduled_time, alt_hw: t.alt_hw };
        }
    });
    matchedTestTasks.filter(t => t.source_date === state.selectedDate || t.scheduled_date === state.selectedDate).forEach(t => {
        const key = t.domain || t.type || 'etc';
        if (!summary.test_fail_actions[key]) {
            summary.test_fail_actions[key] = { type: t.type, scheduled_date: t.scheduled_date, scheduled_time: t.scheduled_time, alt_hw: t.alt_hw };
        }
    });

    return summary;
}

// ─── Gemini API 요청 큐 + 재시도 ─────────────────────────────────────────────
const _geminiQueue = [];
let _geminiRunning = false;
const GEMINI_MIN_INTERVAL = 1200; // 요청 간 최소 간격 (ms)
let _geminiLastCall = 0;

async function _geminiWithRetry(prompt, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const result = await geminiModel.generateContent(prompt);
            return result;
        } catch (err) {
            const is429 = err?.message?.includes('429') || err?.message?.includes('Resource exhausted');
            if (!is429 || attempt === maxRetries - 1) throw err;
            const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
            console.warn(`Gemini 429 → ${delay / 1000}초 후 재시도 (${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

function _enqueueGemini(prompt) {
    return new Promise((resolve, reject) => {
        _geminiQueue.push({ prompt, resolve, reject });
        if (!_geminiRunning) _processGeminiQueue();
    });
}

async function _processGeminiQueue() {
    _geminiRunning = true;
    while (_geminiQueue.length > 0) {
        const { prompt, resolve, reject } = _geminiQueue.shift();
        const elapsed = Date.now() - _geminiLastCall;
        if (elapsed < GEMINI_MIN_INTERVAL) {
            await new Promise(r => setTimeout(r, GEMINI_MIN_INTERVAL - elapsed));
        }
        try {
            _geminiLastCall = Date.now();
            const result = await _geminiWithRetry(prompt);
            resolve(result);
        } catch (err) {
            reject(err);
        }
    }
    _geminiRunning = false;
}

export async function generateParentMessage(studentId) {
    const summary = collectStudentDaySummary(studentId);
    if (!summary) return '학생 정보를 찾을 수 없습니다.';

    // PII 제거 + 후속 조치는 데이터 템플릿에서만 표시 (AI 서술에서 제외)
    const safeSummary = { ...summary };
    delete safeSummary.student_phone;
    delete safeSummary.parent_phone_1;
    delete safeSummary.parent_phone_2;
    delete safeSummary.hw_fail_actions;
    delete safeSummary.test_fail_actions;
    delete safeSummary.extra_visit;

    const customPrompt = getCustomPrompt().replace('{name}', summary.name);
    const noteSection = summary.note ? `\n\n선생님 메모:\n${summary.note}` : '';
    const teacherNote = document.getElementById('parent-msg-note')?.value?.trim();
    const teacherNoteSection = teacherNote ? `\n\n선생님 특이사항:\n${teacherNote}` : '';
    const fullPrompt = `${customPrompt}${noteSection}${teacherNoteSection}\n\n학생 데이터:\n${JSON.stringify(safeSummary, null, 2)}`;

    const result = await _enqueueGemini(fullPrompt);
    const aiComment = result.response.text().trim();

    // AI 코멘트 + 구분선 + 데이터 합치기
    const dataTemplate = generateDataTemplate(studentId);
    return decodeHtmlEntities(`${aiComment}\n\n────────────────\n${dataTemplate}`);
}

// 약어 → 학부모용 풀네임 변환
const DOMAIN_FULL_NAMES = {
    'Gr': 'Grammar', 'A/G': 'Applied Grammar', 'R/C': 'Reading Comprehension',
    'Vo': 'Vocabulary', 'Id': 'Idiom', 'V3': 'Verb 3형식',
    'L/C': 'Listening and Comprehension'
};
function domainFullName(abbr) { return DOMAIN_FULL_NAMES[abbr] || abbr; }

export function generateDataTemplate(studentId) {
    const summary = collectStudentDaySummary(studentId);
    if (!summary) return '';

    // 날짜 포맷: "3/4(화)" (연도 제외, 요일 포함)
    const fmtDate = (dateStr) => {
        if (!dateStr) return '';
        const d = parseDateKST(dateStr);
        const day = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
        return `${d.getMonth() + 1}/${d.getDate()}(${day})`;
    };

    const lines = [];
    lines.push(`[${fmtDate(summary.date)}] 수업 결과`);

    // 출결
    const att = summary.attendance === '미확인' ? '정규' : summary.attendance;
    lines.push(`>출결: ${att}`);

    // 영역별 흐름 생성 헬퍼 (1차 → 2차 → 후속조치)
    const formatActionStep = (action) => {
        if (!action?.type) return null;
        const time = action.scheduled_time ? ` ${formatTime12h(action.scheduled_time)}` : '';
        if (action.type === '등원') {
            return `${fmtDate(action.scheduled_date)}${time} 등원`;
        }
        if (action.type === '대체숙제') return `대체숙제 "${action.alt_hw || ''}"`;
        if (action.type === '미통과') {
            if (action.scheduled_date) return `${fmtDate(action.scheduled_date)}${time} 재시`;
            return '보충 예정';
        }
        return null;
    };

    const buildDomainFlow = (data1st, data2nd, actions, label) => {
        const domains = [...new Set([...Object.keys(data1st), ...Object.keys(data2nd)])];
        domains.forEach(d => {
            const steps = [];
            if (data1st[d]) steps.push(data1st[d]);
            if (data2nd[d]) steps.push(data2nd[d]);
            const step = formatActionStep(actions[d]);
            if (step) steps.push(step);
            lines.push(`>${domainFullName(d)} ${label}: ${steps.join(' → ')}`);
        });
    };

    // 숙제
    buildDomainFlow(summary.homework_1st, summary.homework_2nd, summary.hw_fail_actions, '숙제');

    // 테스트
    buildDomainFlow(summary.test_1st, summary.test_2nd, summary.test_fail_actions, '테스트');

    // 클리닉
    const ev = summary.extra_visit;
    if (ev.date) {
        const evTime = ev.time ? ` ${formatTime12h(ev.time)}` : '';
        const evReason = ev.reason ? ` (${ev.reason})` : '';
        lines.push(`>클리닉: ${fmtDate(ev.date)}${evTime}${evReason}`);
    }

    // 다음 숙제
    const student = state.allStudents.find(s => s.docId === studentId);
    if (student) {
        const dayName = getDayName(state.selectedDate);
        const todayEnrolls = student.enrollments.filter(e =>
            e.day.includes(dayName)
        );
        const NEXT_HW_NAMES = {
            'Gr': '문법', 'A/G': '실전문법', 'R/C': '독해',
            'Vo': 'Vocabulary', 'Id': 'Idiom', 'V3': 'Verb 3형식',
            'L/C': '청해', 'Su': '써머리', 'Sm': '써머리'
        };
        const DOMAIN_ALIASES = { '듣기': '청해', '실전': '실전문법' };
        const nextHwName = (abbr) => {
            const name = NEXT_HW_NAMES[abbr] || abbr;
            return DOMAIN_ALIASES[name] || name;
        };
        const nextHwEntries = [];
        const seenHw = new Set();
        todayEnrolls.forEach(e => {
            const code = enrollmentCode(e);
            const data = state.classNextHw[code]?.domains || {};
            Object.entries(data).forEach(([d, v]) => {
                if (!v) return;
                const content = v.trim();
                if (!content || content === '없음') return;
                const display = nextHwName(d);
                const key = `${display}::${content}`;
                if (!seenHw.has(key)) {
                    seenHw.add(key);
                    nextHwEntries.push(`${display}: ${content}`);
                }
            });
        });
        if (nextHwEntries.length > 0) {
            lines.push('');
            lines.push('> 다음 숙제:');
            nextHwEntries.forEach(entry => lines.push(`  - ${entry}`));
        }
    }

    return lines.join('\n');
}

export function generateManualTemplate(studentId) {
    const summary = collectStudentDaySummary(studentId);
    if (!summary) return '';

    const header = `안녕하세요, ${summary.name} 학부모님.\n`;
    const data = generateDataTemplate(studentId);
    const footer = '\n\n감사합니다. 임팩트7';

    return decodeHtmlEntities(header + data + footer);
}

export function switchParentMsgTab(mode) {
    parentMsgMode = mode;
    document.getElementById('parent-msg-tab-ai').classList.toggle('active', mode === 'ai');
    document.getElementById('parent-msg-tab-manual').classList.toggle('active', mode === 'manual');
    document.getElementById('parent-msg-ai-panel').style.display = mode === 'ai' ? '' : 'none';
    document.getElementById('parent-msg-manual-panel').style.display = mode === 'manual' ? '' : 'none';

    if (mode === 'manual' && parentMsgStudentId) {
        const manualText = document.getElementById('parent-msg-manual-text');
        if (manualText && !manualText.value) {
            manualText.value = generateManualTemplate(parentMsgStudentId);
        }
    }
}

export function openParentMessageModal(studentId) {
    parentMsgStudentId = studentId;
    parentMsgMode = 'ai';

    document.getElementById('parent-msg-modal').style.display = '';
    document.getElementById('parent-msg-tab-ai').classList.add('active');
    document.getElementById('parent-msg-tab-manual').classList.remove('active');
    document.getElementById('parent-msg-ai-panel').style.display = '';
    document.getElementById('parent-msg-manual-panel').style.display = 'none';
    document.getElementById('parent-msg-loading').style.display = 'none';
    document.getElementById('parent-msg-text').style.display = '';
    document.getElementById('parent-msg-text').value = '';
    document.getElementById('parent-msg-copied').style.display = 'none';

    // 프롬프트 에디터 접기
    const editor = document.getElementById('parent-msg-prompt-editor');
    if (editor) editor.style.display = 'none';
    const arrow = document.getElementById('prompt-arrow');
    if (arrow) arrow.classList.remove('expanded');

    // 특이사항 & Manual 초기화
    const noteInput = document.getElementById('parent-msg-note');
    if (noteInput) noteInput.value = '';
    const manualText = document.getElementById('parent-msg-manual-text');
    if (manualText) manualText.value = '';
}

export async function regenerateParentMessage() {
    if (!parentMsgStudentId) return;
    if (parentMsgMode === 'ai') {
        const loadingEl = document.getElementById('parent-msg-loading');
        const msgTextEl = document.getElementById('parent-msg-text');
        if (loadingEl) {
            loadingEl.style.display = '';
            loadingEl.innerHTML = `<div class="spinner"></div>
            Gemini가 알림 메시지를 작성하고 있습니다...`;
        }
        if (msgTextEl) msgTextEl.style.display = 'none';
        try {
            const message = await generateParentMessage(parentMsgStudentId);
            if (msgTextEl) { msgTextEl.value = message; msgTextEl.style.display = ''; }
            if (loadingEl) loadingEl.style.display = 'none';
        } catch (err) {
            console.error('메시지 재생성 실패:', err);
            if (loadingEl) loadingEl.innerHTML = `
                <span class="material-symbols-outlined" style="font-size:28px;color:var(--danger);">error</span>
                메시지 생성에 실패했습니다.<br><span style="font-size:11px;">${esc(err.message)}</span>`;
        }
    } else {
        const manualText = document.getElementById('parent-msg-manual-text');
        if (manualText) manualText.value = generateManualTemplate(parentMsgStudentId);
    }
}

export function copyParentMessage() {
    const textEl = parentMsgMode === 'ai'
        ? document.getElementById('parent-msg-text')
        : document.getElementById('parent-msg-manual-text');
    if (!textEl) return;
    navigator.clipboard.writeText(textEl.value).then(() => {
        const copied = document.getElementById('parent-msg-copied');
        if (copied) {
            copied.style.display = '';
            setTimeout(() => { copied.style.display = 'none'; }, 2000);
        }
    }).catch(err => {
        console.error('클립보드 복사 실패:', err);
        alert('클립보드 복사에 실패했습니다.');
    });
}
