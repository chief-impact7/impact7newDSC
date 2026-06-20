import * as XLSX from 'xlsx';
import { normalizePhones } from './message-format.js';

// 셀 값을 텍스트로. number 셀(엑셀이 전화번호를 숫자로 저장)은 선행 0이 소실되므로 복원한다.
// 한국 전화번호는 항상 0으로 시작하므로 number화로 사라진 0은 정확히 하나뿐 → '0' prefix로 복원.
function cellToText(cell) {
  if (typeof cell === 'number') return '0' + cell;
  return String(cell ?? '');
}

// Excel(.xlsx/.xls)·CSV 파일에서 전화번호를 추출해 중복 제거 후 반환.
// XLSX.read가 파일 시그니처로 csv/xlsx를 자동 판별하므로 확장자 분기는 불필요.
// 번호 판정은 normalizePhones(서버 parseRecipients와 동일 규칙)에 위임한다.
export async function parsePhonesFromFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const phones = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false });
    for (const row of rows) for (const cell of row) phones.push(...normalizePhones(cellToText(cell)));
  }
  return [...new Set(phones)];
}

// 업로드용 샘플 CSV. 한 열에 번호만 있으면 된다(어느 칸이든 번호는 인식되지만 안내용 양식).
export function sampleCsv() {
  return '수신번호\n01012345678\n010-9876-5432\n';
}
