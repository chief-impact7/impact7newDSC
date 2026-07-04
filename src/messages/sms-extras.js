// 휴대폰 문자 전송 부가 문구 — 채널 가입 안내(고정)와 학원 꼬리말(전 직원 공유 설정).
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../../firebase-config.js';

// 채널 가입 안내 — 서버 fallback 문구(functions-shared/src/channelInvite.js)와 같은 문안·링크.
// 서버 쪽을 바꾸면 여기도 함께 바꿀 것(수동 삽입용 클라 사본).
export const CHANNEL_INVITE_SMS =
  '카카오톡 채널 미가입으로 문자 안내드립니다. 자유로운 소통은 채널 가입으로 가능합니다. → https://talk.impact7.kr/kakao';

// 학원 꼬리말(서명) — message_settings/global 문서에 전 직원 공유로 저장.
const SETTINGS_REF = () => doc(db, 'message_settings', 'global');

export async function getSmsFooter() {
  const snap = await getDoc(SETTINGS_REF());
  return snap.exists() ? String(snap.data().sms_footer ?? '') : '';
}

export async function saveSmsFooter(footer) {
  await setDoc(SETTINGS_REF(), {
    sms_footer: String(footer ?? '').trim(),
    updated_by: auth.currentUser?.email ?? null,
    updated_at: serverTimestamp(),
  });
}

// 본문 끝에 문구를 덧붙인다(이미 포함돼 있으면 그대로 — 중복 방지).
export function appendLine(content, line) {
  if (!line || content.includes(line)) return content;
  return content.trim() ? content.replace(/\s*$/, '') + '\n\n' + line : line;
}
