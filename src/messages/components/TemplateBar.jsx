import React, { useEffect, useState } from 'react';
import { IconButton } from '@impact7/ui';
import { loadTemplates, saveTemplate, deleteTemplate, migrateLegacyTemplates } from '../message-templates.js';
import { ICON_NAME } from '../../dashboard/icon-map.js';

// 자주 쓰는 문구 불러오기/저장 — 전 직원 공유(Firestore). content를 받아 저장하고,
// 선택 시 onPick(content)로 본문에 채운다. 첫 마운트에 개인 단말(localStorage) 템플릿을 1회 이관.
export default function TemplateBar({ content, onPick }) {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      await migrateLegacyTemplates();
      const l = await loadTemplates().catch(() => []);
      if (alive) setList(l);
    })();
    return () => { alive = false; };
  }, []);

  async function refresh() {
    setList(await loadTemplates().catch(() => list));
  }

  function pick(title) {
    setSel(title);
    const t = list.find((x) => x.title === title);
    if (t) onPick(t.content);
  }
  async function onSave() {
    if (busy || !titleInput.trim() || !content.trim()) return;
    setBusy(true); setErr('');
    try {
      setList(await saveTemplate(titleInput, content));
      setSel(titleInput.trim()); setTitleInput(''); setSaveOpen(false);
    } catch (e) {
      setErr('저장 실패: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function removeTemplate(title) {
    if (busy || !title) return;
    if (!confirm(`템플릿 "${title}"을(를) 삭제할까요?\n모든 직원에게서 삭제됩니다.`)) return;
    setBusy(true); setErr('');
    try {
      setList(await deleteTemplate(title));
      if (sel === title) setSel('');
    } catch (e) {
      setErr('삭제 실패: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  // 수정 = 본문에 불러오고 같은 제목으로 저장 대기 상태 — [저장]을 누르면 덮어쓴다.
  function startEdit(t) {
    onPick(t.content);
    setSel(t.title);
    setTitleInput(t.title);
    setSaveOpen(true);
    setManageOpen(false);
  }

  return (
    <div className="mc-tpl" style={{ position: 'relative' }}>
      <select aria-label="템플릿 선택" value={sel} onChange={(e) => pick(e.target.value)} onFocus={refresh}>
        <option value="">템플릿 불러오기…</option>
        {list.map((t) => <option key={t.title} value={t.title}>{t.title}</option>)}
      </select>
      <IconButton icon={ICON_NAME.quiz} label="템플릿 관리" aria-expanded={manageOpen}
        onClick={async () => { if (!manageOpen) await refresh(); setManageOpen(!manageOpen); }} />
      {saveOpen ? (
        <>
          <input aria-label="템플릿 이름" className="mc-tpl-title" value={titleInput} onChange={(e) => setTitleInput(e.target.value)}
            placeholder="템플릿 이름" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } }} />
          <button type="button" className="mc-tpl-save" onClick={onSave} disabled={busy || !titleInput.trim() || !content.trim()}>{busy ? '저장 중…' : '저장'}</button>
          <IconButton icon="xMark" label="취소" onClick={() => { setSaveOpen(false); setTitleInput(''); }} />
        </>
      ) : (
        <button type="button" className="mc-tpl-save" onClick={() => setSaveOpen(true)} disabled={!content.trim()}>현재 내용 저장</button>
      )}
      {err && <span role="status" aria-live="polite" style={{ fontSize: 12, color: '#c5221f' }}>{err}</span>}
      {manageOpen && (
        <div className="mc-tpl-manage" role="group" aria-label="템플릿 관리"
          onKeyDown={(e) => { if (e.key === 'Escape') setManageOpen(false); }}>
          <div className="mc-tpl-manage-head">
            템플릿 관리 <span style={{ color: '#999', fontWeight: 400 }}>{list.length}개 · 전 직원 공유</span>
            <IconButton icon="xMark" label="닫기" style={{ marginLeft: 'auto' }} onClick={() => setManageOpen(false)} />
          </div>
          {list.length === 0 && <div style={{ color: '#888', fontSize: 12.5, padding: '6px 0' }}>저장된 템플릿이 없습니다.</div>}
          {list.map((t) => (
            <div key={t.title} className="mc-tpl-manage-row">
              <div className="mc-tpl-manage-main">
                <div className="mc-tpl-manage-title">{t.title}</div>
                <div className="mc-tpl-manage-preview">{t.content}</div>
              </div>
              <IconButton icon="pencil" label="수정 — 본문에 불러온 뒤 저장하면 덮어씀" disabled={busy} onClick={() => startEdit(t)} />
              <IconButton icon="trash" tone="danger" label="삭제" disabled={busy} onClick={() => removeTemplate(t.title)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
