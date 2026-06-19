// 문자 길이/종류 표시용. 솔라피 SMS 기준 90바이트(한글·전각 2바이트, ASCII 1바이트, EUC-KR 근사).
// 90바이트 이하면 SMS(단문), 초과하면 LMS(장문)로 자동 분류된다.
const SMS_BYTE_LIMIT = 90;

export function smsByteLen(text) {
  let n = 0;
  for (const ch of String(text ?? '')) {
    n += ch.codePointAt(0) > 0x7f ? 2 : 1;
  }
  return n;
}

export function messageType(text) {
  return smsByteLen(text) <= SMS_BYTE_LIMIT ? 'SMS' : 'LMS';
}

// 작성 영역 하단에 보여줄 요약: 글자수·바이트·종류.
export function messageMeta(text) {
  const s = String(text ?? '');
  const bytes = smsByteLen(s);
  return { chars: [...s].length, bytes, type: bytes <= SMS_BYTE_LIMIT ? 'SMS' : 'LMS', limit: SMS_BYTE_LIMIT };
}
