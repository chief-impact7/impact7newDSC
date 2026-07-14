// ─── 학부모 알림 메시지 생성 ────────────────────────────────────────────────
// daily-ops.js에서 분리 (Phase 2-1)

import { msIcon } from './ms-icon.js';
import { state } from './state.js';
import { createGeminiQueue } from './gemini-queue.js';
import { parseDateKST, getDayName } from './src/shared/firestore-helpers.js';
import { esc, decodeHtmlEntities, formatTime12h, formatTime12hNoAmPm, showSaveIndicator } from './ui-utils.js';
import { enrollmentCode } from './student-helpers.js';
import { sendDailyReport, sendParentNotice, addConsultation, saveStudentParentMessageRecipientFields } from './data-layer.js';
import { buildConsultationPayload } from './consultation-payload.js';
import { defaultRecipientFields, normalizeRecipientFields } from './src/messages/recipient-settings.js';
import { onlyDigits } from './src/messages/message-format.js';
import { todayKST } from '@impact7/shared/datetime';

let _sendingReport = false;
let _parentMsgRecipientFields = new Set(['parent_1']);
let _recipientSaveQueue = Promise.resolve();

// 백엔드 recipientPhone.js의 RECIPIENT_FIELDS와 일치. 번호가 있는 대상만 노출한다.
const RECIPIENT_OPTIONS = [
    { field: 'student', label: '학생', key: 'student_phone' },
    { field: 'parent_1', label: '학부모1', key: 'parent_phone_1' },
    { field: 'parent_2', label: '학부모2', key: 'parent_phone_2' },
    { field: 'other', label: '기타', key: 'other_phone' },
];

function parentMessageRecipientFields(student, availableFields) {
    const saved = normalizeRecipientFields(student?.parent_message_recipient_fields, availableFields);
    return saved ?? defaultRecipientFields(availableFields);
}

function saveParentMessageRecipientFields(studentId) {
    const fields = [..._parentMsgRecipientFields];
    const student = getStudent?.(studentId);
    if (student) student.parent_message_recipient_fields = fields;
    _recipientSaveQueue = _recipientSaveQueue
        .catch(() => {})
        .then(() => saveStudentParentMessageRecipientFields(studentId, fields))
        .catch((err) => {
            console.error('[parent-message] 수신 대상 저장 실패:', err);
        });
    return _recipientSaveQueue;
}

// 학생 번호 유무에 따라 수신 대상 체크박스를 채운다. 학부모알림작성 전용 선택값만 사용한다.
function populateRecipientChecks(studentId) {
    const box = document.getElementById('parent-msg-recipient');
    if (!box) return;
    const student = getStudent?.(studentId) || {};
    const available = RECIPIENT_OPTIONS.filter((o) => onlyDigits(student[o.key]));
    const availableFields = available.map((o) => o.field);
    _parentMsgRecipientFields = new Set(parentMessageRecipientFields(student, availableFields));
    if (!available.length) {
        box.innerHTML = '<span class="parent-msg-recipient-empty">등록된 연락처 없음</span>';
        return;
    }
    box.innerHTML = available.map((o) => {
        const tail = onlyDigits(student[o.key]).slice(-4);
        const checked = _parentMsgRecipientFields.has(o.field) ? 'checked' : '';
        return `<label class="parent-msg-recipient-check">
            <input type="checkbox" name="parent-msg-recipient-field" value="${o.field}" ${checked}>
            <span>${esc(o.label)}${tail ? ` (${tail})` : ''}</span>
        </label>`;
    }).join('');
    box.querySelectorAll('input[name="parent-msg-recipient-field"]').forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) _parentMsgRecipientFields.add(input.value);
            else _parentMsgRecipientFields.delete(input.value);
            void saveParentMessageRecipientFields(studentId);
        });
    });
}

// ─── 의존성 주입 (daily-ops.js에서 init 호출) ──────────────────────────────
let getStudentDomains, getStudentTestItems, getStudentChecklistStatus, getStudent, getCurrentTeacher;

export function initParentMessageDeps(deps) {
    getStudentDomains = deps.getStudentDomains;
    getStudentTestItems = deps.getStudentTestItems;
    getStudentChecklistStatus = deps.getStudentChecklistStatus;
    getStudent = deps.getStudent;
    getCurrentTeacher = deps.getCurrentTeacher;
}

// ─── 모듈 내부 변수 ────────────────────────────────────────────────────────
let parentMsgStudentId = null;
let parentMsgMode = 'ai'; // 'ai' | 'manual'

const DEFAULT_PARENT_MSG_PROMPT = `영어학원 "임팩트7" 담당 선생님이 학부모님께 보내는 총평 코멘트를 작성하세요.

규칙:
- 존댓말, 따뜻한 톤, 긍정적이고 공감하는 감정과 말투. 이모지 금지
- 인사말 없이 바로 내용 시작
- "오늘" 대신 요일로 지칭 (데이터에서 날짜 확인)
- 학생 데이터의 시간 값(arrival_time 등)은 이미 "h:mm" 콜론 형식(예: "5:30")으로 제공됨 — 그 형식을 바꾸지 말고 그대로 사용
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
- 시간 표기에 "오전"·"오후"·"시"·"분" 같은 단어를 절대 쓰지 말 것. 반드시 "5:30"처럼 콜론 숫자만 쓸 것 (17:30→"5:30", 08:20→"8:20". "오후 5:30", "5시 30분" 모두 금지)
- 오직 제공된 학생 데이터에 존재하는 항목만 근거로 작성할 것`;

function getCustomPrompt() {
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

function collectStudentDaySummary(studentId) {
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
        summary.hw_fail_actions[key] = { type: t.type, scheduled_date: t.scheduled_date, scheduled_time: t.scheduled_time, alt_hw: t.alt_hw };
    });
    matchedTestTasks.filter(t => t.source_date === state.selectedDate || t.scheduled_date === state.selectedDate).forEach(t => {
        const key = t.domain || t.type || 'etc';
        summary.test_fail_actions[key] = { type: t.type, scheduled_date: t.scheduled_date, scheduled_time: t.scheduled_time, alt_hw: t.alt_hw };
    });

    return summary;
}

// ─── Gemini API 요청 큐 — 상담 제목 생성(gemini-queue.js 싱글턴)과 별도 레인 ──
const _enqueueGemini = createGeminiQueue();

// AI 응답에 시간 표기 규칙이 안 지켜진 잔여 패턴이 남으면 강제 정규화하는 안전망.
// 프롬프트 지시(규칙 텍스트)는 확률적이라 100% 준수를 보장 못한다 — 데이터를 사전 포맷해도
// 자유 텍스트(선생님 메모 등)를 AI가 그대로 인용하며 재도입할 수 있으므로 이중 방어.
function _normalizeAiTimeMentions(text) {
    if (!text) return text;
    return text
        // "h시 m분" → "h:mm" 먼저 변환(자유 텍스트 인용 대비. "3시간 30분"은 "시" 뒤에 숫자가
        // 안 와 매치 안 됨). "오전/오후" 제거보다 앞서야 "오후 6시 3분"의 "오후"까지 지워진다.
        .replace(/(\d{1,2})시\s*(\d{1,2})분/g, (_, h, m) => `${h}:${m.padStart(2, '0')}`)
        // "오전/오후 h:mm" → "h:mm" (접두사 제거)
        .replace(/(오전|오후)\s*(\d{1,2}):(\d{2})/g, '$2:$3')
        // 24시간(13~23):M(M) → 12시간 h:mm. 분은 한 자리도 허용해 zero-pad하고, 뒤에 붙은
        // "분"(있으면)도 함께 삼킨다 — 끝에 \b를 두면 한글은 word character가 아니라 "분" 뒤에서
        // 경계 판정이 실패해 "분"만 매치 밖에 남는 문제가 있어 끝 \b는 생략한다.
        .replace(/\b(1[3-9]|2[0-3]):(\d{1,2})분?/g, (_, h, m) => `${parseInt(h, 10) - 12}:${m.padStart(2, '0')}`);
}

async function generateParentMessage(studentId) {
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

    // 시간 필드를 AI에게 넘기기 전에 최종 표기("5:30")로 미리 변환한다 — AI는 포맷 판단 없이
    // 그대로 옮겨 적기만 하면 되므로, 프롬프트 규칙 문구에만 기대는 것보다 훨씬 안정적이다.
    safeSummary.arrival_time = formatTime12hNoAmPm(safeSummary.arrival_time);
    if (safeSummary.departure?.time) {
        safeSummary.departure = { ...safeSummary.departure, time: formatTime12hNoAmPm(safeSummary.departure.time) };
    }

    const customPrompt = getCustomPrompt().replace('{name}', summary.name);
    const noteSection = summary.note ? `\n\n선생님 메모:\n${summary.note}` : '';
    const teacherNote = document.getElementById('parent-msg-note')?.value?.trim();
    const teacherNoteSection = teacherNote ? `\n\n선생님 특이사항:\n${teacherNote}` : '';
    const fullPrompt = `${customPrompt}${noteSection}${teacherNoteSection}\n\n학생 데이터:\n${JSON.stringify(safeSummary, null, 2)}`;

    const result = await _enqueueGemini(fullPrompt);
    const aiComment = _normalizeAiTimeMentions(result.response.text().trim());

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

function generateDataTemplate(studentId) {
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

function generateManualTemplate(studentId) {
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

    // 수신 대상 — 학부모알림작성 전용 다중 선택.
    populateRecipientChecks(studentId);
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
                ${msIcon('error', '', 'style="font-size:28px;color:var(--danger);"')}
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

function parentMessageContent() {
    const textEl = parentMsgMode === 'ai'
        ? document.getElementById('parent-msg-text')
        : document.getElementById('parent-msg-manual-text');
    return textEl?.value?.trim() || '';
}

function selectedParentMsgRecipients() {
    return [..._parentMsgRecipientFields];
}

function consultationTargetLabel(recipientFields) {
    if (recipientFields.length === 1 && recipientFields[0] === 'student') return '학생';
    if (recipientFields.includes('student')) return '학생/학부모';
    return '학부모';
}

function reportDateLabel() {
    const d = parseDateKST(state.selectedDate);
    if (!d || Number.isNaN(d.getTime())) return state.selectedDate || todayKST();
    return `${d.getMonth() + 1}/${d.getDate()}(${getDayName(state.selectedDate)})`;
}

// 일반 발송은 승인된 수업 리포트 알림톡(ATA)으로 보낸다. 알림톡은 야간 발송 제한을 타지 않는다.
async function _sendReportAlimtalk() {
    if (_sendingReport || !parentMsgStudentId) return;
    const content = parentMessageContent();
    if (!content) { alert('발송할 내용이 없습니다.'); return; }
    const recipientFields = selectedParentMsgRecipients();
    if (!recipientFields.length) { alert('수신 대상을 선택하세요.'); return; }

    const btnIds = ['parent-msg-send-btn', 'parent-msg-send-log-btn'];
    _sendingReport = true;
    btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
    try {
        await sendParentNotice({
            studentId: parentMsgStudentId,
            templateKey: 'report',
            reportDate: state.selectedDate || todayKST(),
            variables: { 날짜: reportDateLabel(), 내용: content },
            recipientFields,
        });
        alert('알림톡 발송을 요청했습니다.');
    } catch (err) {
        console.error('알림톡 발송 실패:', err);
        alert('알림톡 발송 실패: ' + (err?.message || err));
    } finally {
        _sendingReport = false;
        btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; });
    }
}

// 상담+문자는 SMS/LMS 발송을 요청한 뒤 상담 기록을 남긴다.
async function _sendReportWithConsultation() {
    if (_sendingReport || !parentMsgStudentId) return;
    const content = parentMessageContent();
    if (!content) { alert('발송할 내용이 없습니다.'); return; }
    const recipientFields = selectedParentMsgRecipients();
    if (!recipientFields.length) { alert('수신 대상을 선택하세요.'); return; }

    const btnIds = ['parent-msg-send-btn', 'parent-msg-send-log-btn'];
    const sendDate = state.selectedDate || todayKST();
    _sendingReport = true;
    btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
    try {
        // 멱등키를 두지 않는다 — 같은 날 수정본 재발송을 허용. 더블클릭 중복은 _sendingReport
        // 플래그 + 버튼 disabled로 막는다(응답 전까지 재진입 불가).
        const res = await sendDailyReport({
            studentId: parentMsgStudentId,
            content,
            reportDate: sendDate,
            recipientField: recipientFields[0],
            recipientFields,
        });
        let msg = `${res?.queuedCount ?? recipientFields.length}건 문자 발송을 요청했습니다.`;

        try {
            const student = getStudent?.(parentMsgStudentId) || {};
            const teacher = getCurrentTeacher?.() || {};
            await addConsultation(buildConsultationPayload({
                studentId: parentMsgStudentId,
                studentName: student.name || '',
                className: '',
                teacherId: teacher.id || '',
                teacherName: teacher.name || '',
                date: sendDate,
                target: consultationTargetLabel(recipientFields),
                method: '문자',
                consultationType: '정기',
                text: content,
                title: '',
            }));
            msg += ' · 상담 기록 저장됨';
        } catch (e) {
            console.error('상담 기록 저장 실패:', e);
            msg += ' · (상담 저장 실패 — 상담 탭에서 수동 저장하세요: ' + (e?.message || e) + ')';
        }
        alert(msg);
    } catch (err) {
        console.error('리포트 발송 실패:', err);
        alert('발송 실패: ' + (err?.message || err));
    } finally {
        _sendingReport = false;
        btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; });
    }
}

export function sendParentMessage() { return _sendReportAlimtalk(); }
export function sendParentMessageWithConsult() { return _sendReportWithConsultation(); }
