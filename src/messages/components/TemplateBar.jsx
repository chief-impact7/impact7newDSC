import React, { useState } from 'react';
import { loadTemplates, saveTemplate, deleteTemplate } from '../message-templates.js';

// 자주 쓰는 문구 불러오기/저장. content를 받아 저장하고, 선택 시 onPick(content)로 본문에 채운다.
export default function TemplateBar({ content, onPick }) {
  const [list, setList] = useState(() => loadTemplates());
  const [sel, setSel] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  function pick(title) {
    setSel(title);
    const t = list.find((x) => x.title === title);
    if (t) onPick(t.content);
  }
  function onSave() {
    if (!titleInput.trim() || !content.trim()) return;
    setList(saveTemplate(titleInput, content));
    setSel(titleInput.trim()); setTitleInput(''); setSaveOpen(false);
  }
  function onDelete() {
    if (!sel) return;
    setList(deleteTemplate(sel)); setSel('');
  }

  return (
    <div className="mc-tpl">
      <select value={sel} onChange={(e) => pick(e.target.value)} onFocus={() => setList(loadTemplates())}>
        <option value="">템플릿 불러오기…</option>
        {list.map((t) => <option key={t.title} value={t.title}>{t.title}</option>)}
      </select>
      {sel && <button type="button" className="mc-tpl-del" onClick={onDelete}>삭제</button>}
      {saveOpen ? (
        <>
          <input className="mc-tpl-title" value={titleInput} onChange={(e) => setTitleInput(e.target.value)}
            placeholder="템플릿 이름" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } }} />
          <button type="button" className="mc-tpl-save" onClick={onSave} disabled={!titleInput.trim() || !content.trim()}>저장</button>
          <button type="button" className="mc-tpl-del" onClick={() => { setSaveOpen(false); setTitleInput(''); }}>취소</button>
        </>
      ) : (
        <button type="button" className="mc-tpl-save" onClick={() => setSaveOpen(true)} disabled={!content.trim()}>현재 내용 저장</button>
      )}
    </div>
  );
}
