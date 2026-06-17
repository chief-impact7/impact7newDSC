import React, { useState, useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, dataAuthReady } from '../../firebase-config.js';
import { signInWithGoogle, logout } from '../../auth.js';
import { useStudents, useMessageDelivery } from '../dashboard/hooks/useFirestore.js';
import MessageDeliverySummary from '../dashboard/components/MessageDeliverySummary.jsx';
import DirectSmsCard from './components/DirectSmsCard.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u) {
        const email = u.email || '';
        const allowed = email.endsWith('@gw.impact7.kr') || email.endsWith('@impact7.kr');
        if (!u.emailVerified || !allowed) {
          alert('허용되지 않은 계정입니다.');
          logout().catch(() => {});
          setUser(null);
        } else {
          await dataAuthReady();
          setUser(u);
        }
      } else {
        setUser(null);
      }
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const { students } = useStudents(user);
  const { data: msgDelivery, loading: msgLoading, reload: reloadMsg } = useMessageDelivery(user);

  if (authLoading) return <div className="dash-loading">로딩 중…</div>;
  if (!user) return (
    <div className="dash-login">
      <div className="dash-login-card">
        <h1>Impact7 DSC</h1>
        <p>메시지</p>
        <button className="dash-login-btn" onClick={() => signInWithGoogle().catch(() => {})}>학원 계정으로 로그인</button>
      </div>
    </div>
  );

  return (
    <div className="dash-app">
      <header className="dash-header">
        <div className="dash-header-left">
          <h1 className="dash-title">Impact7 DSC</h1>
          <a href="./dashboard.html" className="dash-link">로그북</a>
          <a href="./" className="dash-link">입력 페이지</a>
          <span className="dash-subtitle">메시지</span>
        </div>
        <div className="dash-header-right">
          <span className="dash-user-email">{(user.email || '').replace(/@gw\.impact7\.kr$/i, '@impact7.kr')}</span>
          <button className="dash-avatar" onClick={() => logout().catch(() => {})}>
            {user.email[0].toUpperCase()}
          </button>
        </div>
      </header>

      <div style={{ padding: '24px' }}>
        <section className="mc-section">
          <MessageDeliverySummary data={msgDelivery} students={students} loading={msgLoading} onReload={reloadMsg} />
        </section>
        {/* ②대용량 발송: Plan 2 */}
        <DirectSmsCard />
      </div>
    </div>
  );
}
