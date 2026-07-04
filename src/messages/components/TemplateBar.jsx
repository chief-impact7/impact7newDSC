import React, { useEffect, useState } from 'react';
import { loadTemplates, saveTemplate, deleteTemplate, migrateLegacyTemplates } from '../message-templates.js';

// 자주 쓰는 문구 불러오기/저장 — 전 직원 공유(Firestore). content를 받아 저장하고,
// 선택 시 onPick(content)로 본문에 채운다. 첫 마운트에 개인 단말(localStorage) 템플릿을 1회 이관.
export default function TemplateBar({ content, onPick }) {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
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
  async function onDelete() {
    if (busy || !sel) return;
    setBusy(true); setErr('');
    try {
      setList(await deleteTemplate(sel)); setSel('');
    } catch (e) {
      setErr('삭제 실패: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mc-tpl">
      <select aria-label="템플릿 선택" value={sel} onChange={(e) => pick(e.target.value)} onFocus={refresh}>
        <option value="">템플릿 불러오기…</option>
        {list.map((t) => <option key={t.title} value={t.title}>{t.title}</option>)}
      </select>
      {sel && <button type="button" className="mc-tpl-del" disabled={busy} onClick={onDelete}>삭제</button>}
      {saveOpen ? (
        <>
          <input aria-label="템플릿 이름" className="mc-tpl-title" value={titleInput} onChange={(e) => setTitleInput(e.target.value)}
            placeholder="템플릿 이름" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } }} />
          <button type="button" className="mc-tpl-save" onClick={onSave} disabled={busy || !titleInput.trim() || !content.trim()}>{busy ? '저장 중…' : '저장'}</button>
          <button type="button" className="mc-tpl-del" onClick={() => { setSaveOpen(false); setTitleInput(''); }}>취소</button>
        </>
      ) : (
        <button type="button" className="mc-tpl-save" onClick={() => setSaveOpen(true)} disabled={!content.trim()}>현재 내용 저장</button>
      )}
      {err && <span role="status" aria-live="polite" style={{ fontSize: 12, color: '#c5221f' }}>{err}</span>}
    </div>
  );
}
