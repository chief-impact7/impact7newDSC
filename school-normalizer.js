// 검색어 생성은 shared로 통일. studentSearchTerms를 schoolSearchTerms 이름으로 재노출해
// 기존 callsite(class-student-search/role-memo/leave-request/class-setup) 무수정 유지.
export { studentSearchTerms as schoolSearchTerms } from '@impact7/shared/student-label';
