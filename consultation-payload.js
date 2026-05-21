// 입력 탭 값 → Firestore consultations 문서 객체. firebase 의존 없음 → node:test 가능.
// teacher/ai_processed/created_at은 addConsultation(data-layer)이 추가.

export function buildConsultationPayload({
  studentId, studentName, className,
  teacherId, teacherName,
  date, target, method, consultationType, text, title,
}) {
  return {
    student_id: studentId,
    student_name: studentName,
    class_name: className || '',
    teacher_id: teacherId,
    teacher_name: teacherName,
    date,
    target,
    method,
    consultation_type: consultationType,
    text: (text || '').trim(),
    title: title || '',
  };
}
