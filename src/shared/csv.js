// CSV 직렬화 공용 유틸. 순수 함수(safeCell/csvCell/serializeCsv)는 node:test 가능,
// downloadCsv만 DOM 의존. class-setup-planner.js와 상담 조회 뷰가 공유한다.

// 셀이 = + - @ 탭 CR로 시작하면 Excel/Sheets가 수식으로 평가하므로 작은따옴표 prefix로 텍스트 강제.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function safeCell(value) {
  const s = String(value ?? '');
  return FORMULA_TRIGGER.test(s) ? "'" + s : s;
}

export function csvCell(value) {
  return `"${safeCell(value).replace(/"/g, '""')}"`;
}

// headers + rows → CSV 문자열. UTF-8 BOM prefix로 엑셀에서 한글이 깨지지 않게 한다.
export function serializeCsv(headers, rows) {
  const lines = [headers, ...rows].map(row => row.map(csvCell).join(','));
  return '﻿' + lines.join('\n');
}

// 브라우저에서 CSV 파일로 저장.
export function downloadCsv(filename, headers, rows) {
  const blob = new Blob([serializeCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
