// 휴대폰 문자 전송 부가 문구 — 채널 가입 안내와 학원 꼬리말. 둘 다 전 직원 공유 설정
// (message_settings/global)이며, 채널 안내는 미설정 시 아래 기본 문구를 쓴다.
// 기본 문구는 서버 fallback(functions-shared/src/channelInvite.js)과 쌍둥이 — 서버도 같은
// 설정(channel_invite)을 우선 읽으므로, 설정을 바꾸면 수동 삽입·자동 전환 문자 모두 바뀐다.
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../../firebase-config.js';

export const DEFAULT_CHANNEL_INVITE =
  '카카오톡 채널 미가입으로 문자 안내드립니다. 자유로운 소통은 채널 가입으로 가능합니다. → https://talk.impact7.kr/kakao';

const SETTINGS_REF = () => doc(db, 'message_settings', 'global');

// { footer, channelInvite(사용값: 설정||기본), channelInviteCustom(설정 원본, ''=미설정) }
export async function getMessageExtras() {
  const snap = await getDoc(SETTINGS_REF());
  const data = snap.exists() ? snap.data() : {};
  const footer = String(data.sms_footer ?? '').trim();
  const channelInviteCustom = String(data.channel_invite ?? '').trim();
  return { footer, channelInviteCustom, channelInvite: channelInviteCustom || DEFAULT_CHANNEL_INVITE };
}

// 두 문구를 한 번의 merge 쓰기로 저장(원자적 — 부분 실패로 반쪽만 저장되는 상태 방지).
// channel_invite를 빈 값으로 저장하면 기본 문구로 복귀.
export async function saveMessageExtras({ footer, channelInvite }) {
  await setDoc(SETTINGS_REF(), {
    sms_footer: String(footer ?? '').trim(),
    channel_invite: String(channelInvite ?? '').trim(),
    updated_by: auth.currentUser?.email ?? null,
    updated_at: serverTimestamp(),
  }, { merge: true });
}

// 본문 + 체크된 부가 문구(채널 안내·꼬리말)를 발송 본문으로 합성.
// 본문에 이미 같은 문구가 있으면 중복 첨부하지 않는다.
export function composeWithExtras(content, extras = []) {
  const parts = [content.trim()];
  for (const line of extras) {
    if (line && !content.includes(line)) parts.push(line);
  }
  return parts.filter(Boolean).join('\n\n');
}
