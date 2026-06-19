// 학생 상세의 [기록] 탭 — 휴퇴원요청서(이동) + 반성문 + 기타.
import {
  listStudentRecords, newRecordRef, createRecord, updateRecord, uploadRecordFile,
  deleteRecordFiles, deleteRecord,
} from './docu-data.js';
import { splitRecordsByType } from './docu-records.js';
import { renderLeaveRequestCard } from './leave-request.js';
import { esc } from './ui-utils.js';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_CONTENT_LEN = 5000;

let _deps = {};
let _currentStudentId = null;
let _saving = false;
let _editingId = null; // 인라인 편집 중인 기록 id
let _editBuffer = null; // 편집 중 미저장 입력(content·occurred_at) 스냅샷 — 재렌더 유실 방지

export function initDocuCardDeps(deps) {
  _deps = deps; // { toast, readonly }
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function fileListHtml(files) {
  if (!files || !files.length) return '';
  return `<div class="docu-chips docu-record-files">${files.map(f =>
    `<span class="docu-chip"><span class="material-symbols-outlined">image</span>${esc(f.name)}</span>`).join('')}</div>`;
}

function recordItemHtml(rec) {
  if (!_deps.readonly && _editingId === rec.id) return recordEditHtml(rec);
  const actions = _deps.readonly ? '' : `<div class="docu-record-actions">
      <button class="icon-btn docu-edit-btn" title="수정" aria-label="수정" onclick="window.__docuEdit('${esc(rec.id)}')"><span class="material-symbols-outlined">edit</span></button>
      <button class="icon-btn docu-del-btn" title="삭제" aria-label="삭제" onclick="window.__docuDelete('${esc(rec.id)}')"><span class="material-symbols-outlined">delete</span></button>
    </div>`;
  return `<div class="docu-record-item" data-id="${esc(rec.id)}">
    <div class="docu-record-head">
      <span class="docu-record-date"><span class="material-symbols-outlined">event</span>${esc(rec.occurred_at || '—')}</span>
      ${actions}
    </div>
    ${rec.content ? `<div class="docu-record-content">${esc(rec.content)}</div>` : ''}
    ${fileListHtml(rec.files)}
  </div>`;
}

// 인라인 편집 폼 — 입력폼(.docu-input)과 동일한 디자인 언어 재사용. 기존 첨부는 그대로 표시.
function recordEditHtml(rec) {
  const id = esc(rec.id);
  // 같은 항목 재렌더 시 미저장 버퍼 우선(저장본 rec로 덮어쓰지 않음).
  const useBuf = _editBuffer && _editingId === rec.id;
  const content = useBuf ? _editBuffer.content : (rec.content || '');
  const occurredAt = useBuf ? _editBuffer.occurred_at : (rec.occurred_at || '');
  const dateChip = occurredAt
    ? `<span class="docu-chip docu-chip-date"><span class="material-symbols-outlined">event</span>${esc(occurredAt)}</span>`
    : '';
  return `<div class="docu-record-item docu-editing" data-id="${id}">
    <textarea class="field-input docu-content docu-edit-content" maxlength="${MAX_CONTENT_LEN}" rows="2">${esc(content)}</textarea>
    <div class="docu-input-toolbar">
      <input type="date" class="docu-edit-date docu-visually-hidden" value="${esc(occurredAt)}" onchange="window.__docuEditChange('${id}')">
      <button type="button" class="icon-btn docu-icon-btn" title="날짜 선택" aria-label="날짜 선택" onclick="window.__docuEditPickDate('${id}')"><span class="material-symbols-outlined">calendar_month</span></button>
      <input type="file" class="docu-edit-file docu-visually-hidden" accept="image/*" multiple onchange="window.__docuEditChange('${id}')">
      <button type="button" class="icon-btn docu-icon-btn" title="이미지 첨부" aria-label="이미지 첨부" onclick="window.__docuEditPickFile('${id}')"><span class="material-symbols-outlined">image</span></button>
      <div class="docu-chips docu-edit-chips">${dateChip}</div>
      <button class="btn btn-primary btn-sm docu-edit-save" onclick="window.__docuEditSave('${id}')">저장</button>
      <button class="btn btn-secondary btn-sm" onclick="window.__docuEditCancel()">취소</button>
    </div>
    ${fileListHtml(rec.files)}
  </div>`;
}

function sectionHtml(title, type, records, { icon = 'description', contentPlaceholder = '내용', rows = 2 } = {}) {
  // 날짜·파일은 숨긴 input + 아이콘 버튼으로 받고, 선택값은 칩으로 노출(공통 디자인 언어).
  const input = _deps.readonly ? '' : `
    <div class="docu-input" data-type="${type}">
      <textarea class="field-input docu-content" placeholder="${esc(contentPlaceholder)}" maxlength="${MAX_CONTENT_LEN}" rows="${rows}"></textarea>
      <div class="docu-input-toolbar">
        <input type="date" class="docu-date-input docu-visually-hidden" onchange="window.__docuInputChange('${type}')">
        <button type="button" class="icon-btn docu-icon-btn" title="날짜 선택" aria-label="날짜 선택" onclick="window.__docuPickDate('${type}')">
          <span class="material-symbols-outlined">calendar_month</span>
        </button>
        <input type="file" class="docu-file-input docu-visually-hidden" accept="image/*" multiple onchange="window.__docuInputChange('${type}')">
        <button type="button" class="icon-btn docu-icon-btn" title="이미지 첨부" aria-label="이미지 첨부" onclick="window.__docuPickFile('${type}')">
          <span class="material-symbols-outlined">image</span>
        </button>
        <div class="docu-chips" data-chips="${type}"></div>
        <button class="btn btn-primary btn-sm docu-save-btn" onclick="window.__docuSave('${type}')">저장</button>
      </div>
    </div>`;
  // 기록 없으면 목록 영역을 아예 비워 카드 높이를 줄인다(빈 안내문 제거).
  const listHtml = records.length
    ? `<div class="docu-record-list">${records.map(recordItemHtml).join('')}</div>`
    : '';
  return `<div class="detail-card">
    <div class="detail-card-title"><span class="material-symbols-outlined">${icon}</span>${esc(title)}</div>
    ${input}
    ${listHtml}
  </div>`;
}

// 선택한 날짜·파일을 칩으로 다시 그린다(아이콘 버튼만 보이므로 선택값 피드백 필요).
function renderChips(type) {
  const box = document.querySelector(`.docu-input[data-type="${type}"]`);
  const chipsEl = box?.querySelector('.docu-chips');
  if (!chipsEl) return;
  const dateVal = box.querySelector('.docu-date-input')?.value || '';
  const files = box.querySelector('.docu-file-input')?.files;
  const parts = [];
  if (dateVal) parts.push(`<span class="docu-chip docu-chip-date"><span class="material-symbols-outlined">event</span>${esc(dateVal)}</span>`);
  for (const f of files || []) parts.push(`<span class="docu-chip"><span class="material-symbols-outlined">image</span>${esc(f.name)}</span>`);
  chipsEl.innerHTML = parts.join('');
}

export async function renderDocuTab(studentId) {
  if (_currentStudentId !== studentId) {
    _editingId = null; _editBuffer = null; // 학생 전환 시 편집 모드·버퍼 해제
  } else if (_editingId) {
    // 같은 학생 재렌더(휴퇴원 버튼 등)로 DOM이 교체되기 전에 편집 중 입력을 스냅샷.
    const box = editBox(_editingId);
    if (box) {
      _editBuffer = {
        content: box.querySelector('.docu-edit-content')?.value ?? '',
        occurred_at: box.querySelector('.docu-edit-date')?.value ?? '',
      };
    }
  }
  _currentStudentId = studentId;
  const el = document.getElementById('docu-tab');
  if (!el) return;
  el.innerHTML = `<div class="detail-card-empty" style="padding:32px;text-align:center;">불러오는 중…</div>`;

  let records = [];
  try { records = await listStudentRecords(studentId); }
  catch (err) { console.warn('[docu] 조회 실패:', err); _deps.toast?.('기록 조회 실패', 'error'); }
  if (_currentStudentId !== studentId) return; // stale 방지

  const { reflections, etc } = splitRecordsByType(records);
  el.innerHTML = `
    ${renderLeaveRequestCard(studentId)}
    ${sectionHtml('반성문', 'reflection', reflections, { icon: 'history_edu', contentPlaceholder: '간단한 내용', rows: 1 })}
    ${sectionHtml('기타', 'etc', etc, { icon: 'edit_note', contentPlaceholder: '내용', rows: 1 })}
  `;
}

// 아이콘 버튼 → 숨긴 input 트리거. showPicker 미지원 브라우저는 click으로 fallback.
window.__docuPickDate = function (type) {
  const inp = document.querySelector(`.docu-input[data-type="${type}"] .docu-date-input`);
  if (!inp) return;
  if (typeof inp.showPicker === 'function') {
    try { inp.showPicker(); return; } catch { /* fallback below */ }
  }
  inp.click();
};

window.__docuPickFile = function (type) {
  document.querySelector(`.docu-input[data-type="${type}"] .docu-file-input`)?.click();
};

window.__docuInputChange = function (type) { renderChips(type); };

// ── 인라인 편집 ──────────────────────────────────────────────────────────────
function editBox(id) { return document.querySelector(`.docu-record-item.docu-editing[data-id="${id}"]`); }

function renderEditChips(id) {
  const box = editBox(id);
  const chipsEl = box?.querySelector('.docu-edit-chips');
  if (!chipsEl) return;
  const dateVal = box.querySelector('.docu-edit-date')?.value || '';
  const files = box.querySelector('.docu-edit-file')?.files;
  const parts = [];
  if (dateVal) parts.push(`<span class="docu-chip docu-chip-date"><span class="material-symbols-outlined">event</span>${esc(dateVal)}</span>`);
  for (const f of files || []) parts.push(`<span class="docu-chip"><span class="material-symbols-outlined">image</span>${esc(f.name)}</span>`);
  chipsEl.innerHTML = parts.join('');
}

window.__docuEdit = function (recordId) {
  if (_deps.readonly || _saving || !_currentStudentId) return;
  _editingId = recordId;
  _editBuffer = null; // 편집 진입 시 저장본 값으로 시작
  renderDocuTab(_currentStudentId);
};

window.__docuEditCancel = function () {
  _editingId = null;
  _editBuffer = null;
  if (_currentStudentId) renderDocuTab(_currentStudentId);
};

window.__docuEditPickDate = function (id) {
  const inp = editBox(id)?.querySelector('.docu-edit-date');
  if (!inp) return;
  if (typeof inp.showPicker === 'function') {
    try { inp.showPicker(); return; } catch { /* fallback below */ }
  }
  inp.click();
};

window.__docuEditPickFile = function (id) {
  editBox(id)?.querySelector('.docu-edit-file')?.click();
};

window.__docuEditChange = function (id) { renderEditChips(id); };

window.__docuEditSave = async function (recordId) {
  if (_deps.readonly || !_currentStudentId || _saving) return; // 더블클릭 가드
  const studentId = _currentStudentId;
  const box = editBox(recordId);
  if (!box) return;
  // 날짜 미입력 시 오늘을 기본값으로(입력폼과 동일 규칙).
  const occurred_at = box.querySelector('.docu-edit-date')?.value || todayStr();
  const content = box.querySelector('.docu-edit-content')?.value || '';
  const fileInput = box.querySelector('.docu-edit-file');
  const newFiles = fileInput ? [...fileInput.files] : [];
  const saveBtn = box.querySelector('.docu-edit-save');

  if (content.length > MAX_CONTENT_LEN) {
    _deps.toast?.(`내용은 ${MAX_CONTENT_LEN}자 이하만 가능합니다`, 'warn');
    return;
  }
  for (const f of newFiles) {
    if (f.size >= MAX_FILE_BYTES) { _deps.toast?.(`파일은 15MB 미만만 가능합니다: ${f.name}`, 'warn'); return; }
    if (!/^image\//.test(f.type)) { _deps.toast?.(`이미지 파일만 첨부할 수 있습니다: ${f.name}`, 'warn'); return; }
  }

  _saving = true;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const patch = { occurred_at, content };
    // 추가 첨부가 있으면 기존 files에 병합(파일 개별 삭제는 범위 밖).
    if (newFiles.length) {
      const records = await listStudentRecords(studentId);
      const existingFiles = records.find(r => r.id === recordId)?.files || [];
      const metas = [];
      try {
        for (let i = 0; i < newFiles.length; i++) {
          metas.push(await uploadRecordFile(studentId, recordId, newFiles[i], existingFiles.length + i));
        }
      } catch (upErr) {
        await deleteRecordFiles(metas);
        throw upErr;
      }
      patch.files = [...existingFiles, ...metas];
    }
    await updateRecord(recordId, patch);
    _deps.toast?.('수정되었습니다', 'success');
    _editingId = null;
    _editBuffer = null;
    _deps.refreshBadge?.(studentId); // 일시 변경으로 2주 이내 여부가 바뀔 수 있음
    if (_currentStudentId === studentId) renderDocuTab(studentId); // stale 가드
  } catch (err) {
    console.error('[docu] 수정 실패:', err);
    _deps.toast?.('수정 실패', 'error');
    if (saveBtn && document.body.contains(saveBtn)) saveBtn.disabled = false;
  } finally {
    _saving = false;
  }
};

// 인라인 onclick 핸들러 — switchDetailTab 패턴(전역 함수)과 통일.
window.__docuSave = async function (type) {
  if (_deps.readonly || !_currentStudentId || _saving) return; // 더블클릭 가드
  const studentId = _currentStudentId;
  const box = document.querySelector(`.docu-input[data-type="${type}"]`);
  if (!box) return;
  // 날짜 미입력 시 저장일(오늘)을 기본값으로.
  const occurred_at = box.querySelector('.docu-date-input')?.value || todayStr();
  const content = box.querySelector('.docu-content')?.value || '';
  const fileInput = box.querySelector('.docu-file-input');
  const files = fileInput ? [...fileInput.files] : [];
  const saveBtn = box.querySelector('.docu-save-btn');

  // 클라 사전검증 — 문서 생성/업로드 전에 중단(서버 규칙과 동일 한도).
  if (content.length > MAX_CONTENT_LEN) {
    _deps.toast?.(`내용은 ${MAX_CONTENT_LEN}자 이하만 가능합니다`, 'warn');
    return;
  }
  for (const f of files) {
    if (f.size >= MAX_FILE_BYTES) { _deps.toast?.(`파일은 15MB 미만만 가능합니다: ${f.name}`, 'warn'); return; }
    if (!/^image\//.test(f.type)) { _deps.toast?.(`이미지 파일만 첨부할 수 있습니다: ${f.name}`, 'warn'); return; }
  }

  _saving = true;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const recordRef = newRecordRef();
    const recordId = recordRef.id;
    // 파일을 먼저 모두 업로드 → 하나라도 실패하면 이미 올린 객체를 롤백 후 throw.
    const metas = [];
    try {
      for (let i = 0; i < files.length; i++) {
        metas.push(await uploadRecordFile(studentId, recordId, files[i], i));
      }
    } catch (upErr) {
      await deleteRecordFiles(metas);
      throw upErr;
    }
    // 문서는 마지막에 1회만 기록 — 빈 문서/고아 객체 없음.
    await createRecord(recordRef, studentId, type, { occurred_at, content, files: metas });
    _deps.toast?.('저장되었습니다', 'success');
    _deps.refreshBadge?.(studentId); // 방금 추가한 기록은 항상 2주 이내 → 뱃지 갱신
    if (_currentStudentId === studentId) renderDocuTab(studentId); // stale 가드
  } catch (err) {
    console.error('[docu] 저장 실패:', err);
    _deps.toast?.('저장 실패(첨부 업로드 오류)', 'error');
    if (saveBtn && document.body.contains(saveBtn)) saveBtn.disabled = false;
  } finally {
    _saving = false;
  }
};

window.__docuDelete = async function (recordId) {
  if (_deps.readonly || !_currentStudentId || _saving) return;
  const studentId = _currentStudentId;
  let records = [];
  try { records = await listStudentRecords(studentId); } catch { /* 아래에서 처리 */ }
  const rec = records.find(r => r.id === recordId);
  if (!rec) return;
  try {
    const { failed } = await deleteRecord(rec);
    if (failed?.length) _deps.toast?.(`첨부 ${failed.length}건 삭제 실패(수동 정리 필요)`, 'warn');
    else _deps.toast?.('삭제되었습니다', 'success');
    _deps.refreshBadge?.(studentId); // 삭제로 최근 기록이 사라졌을 수 있음 → 뱃지 갱신
    if (_currentStudentId === studentId) renderDocuTab(studentId); // stale 가드
  } catch (err) {
    console.error('[docu] 삭제 실패:', err);
    _deps.toast?.('삭제 실패', 'error');
  }
};
