// 학생 상세의 [기록] 탭 — 휴퇴원요청서(이동) + 반성문 + 기타.
import {
  listStudentRecords, newRecordRef, createRecord, uploadRecordFile,
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

export function initDocuCardDeps(deps) {
  _deps = deps; // { toast, readonly }
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function fileListHtml(files) {
  if (!files || !files.length) return '';
  return `<div class="docu-files">${files.map(f =>
    `<span class="docu-file-chip">${esc(f.name)}</span>`).join('')}</div>`;
}

function recordItemHtml(rec) {
  const del = _deps.readonly ? '' :
    `<button class="btn btn-sm" onclick="window.__docuDelete('${esc(rec.id)}')">삭제</button>`;
  return `<div class="docu-record-item" data-id="${esc(rec.id)}">
    <div class="docu-record-head">
      <span class="docu-record-date">${esc(rec.occurred_at || '—')}</span>
      ${del}
    </div>
    ${rec.content ? `<div class="docu-record-content">${esc(rec.content)}</div>` : ''}
    ${fileListHtml(rec.files)}
  </div>`;
}

function sectionHtml(title, type, records, withContent) {
  const dis = _deps.readonly ? 'disabled' : '';
  const input = _deps.readonly ? '' : `
    <div class="docu-input" data-type="${type}">
      <input type="date" class="field-input docu-date" value="${todayStr()}" ${dis}>
      ${withContent ? `<textarea class="field-input docu-content" placeholder="내용" maxlength="${MAX_CONTENT_LEN}" ${dis}></textarea>` : ''}
      <input type="file" class="docu-file" accept="image/*" multiple ${dis}>
      <button class="btn btn-primary btn-sm" onclick="window.__docuSave('${type}')" ${dis}>저장</button>
    </div>`;
  const list = records.length
    ? records.map(recordItemHtml).join('')
    : `<div class="detail-card-empty">기록이 없습니다.</div>`;
  return `<div class="detail-card">
    <div class="detail-card-title">${esc(title)}</div>
    ${input}
    <div class="docu-record-list">${list}</div>
  </div>`;
}

export async function renderDocuTab(studentId) {
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
    ${sectionHtml('반성문', 'reflection', reflections, false)}
    ${sectionHtml('기타', 'etc', etc, true)}
  `;
}

// 인라인 onclick 핸들러 — switchDetailTab 패턴(전역 함수)과 통일.
window.__docuSave = async function (type) {
  if (_deps.readonly || !_currentStudentId || _saving) return; // 더블클릭 가드
  const studentId = _currentStudentId;
  const box = document.querySelector(`.docu-input[data-type="${type}"]`);
  if (!box) return;
  const occurred_at = box.querySelector('.docu-date')?.value || '';
  const content = box.querySelector('.docu-content')?.value || '';
  const fileInput = box.querySelector('.docu-file');
  const files = fileInput ? [...fileInput.files] : [];
  const saveBtn = box.querySelector('button');

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
    if (_currentStudentId === studentId) renderDocuTab(studentId); // stale 가드
  } catch (err) {
    console.error('[docu] 삭제 실패:', err);
    _deps.toast?.('삭제 실패', 'error');
  }
};
