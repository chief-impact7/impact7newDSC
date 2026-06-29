import { useMemo, useState } from 'react';
import { branchFromStudent, enrollmentCode, allClassCodes } from '../../../student-core.js';
import { studentGradeKey, studentShortLabel } from '../../shared/firestore-helpers.js';
import { downloadCsv } from '../../shared/csv.js';
import {
    filterByStudentIds, groupByDate, groupByStudent, toCsvRows, CONSULTATION_COLUMNS,
} from '../lib/consultation-view.js';

// 상담 형태별 배지 색 — 전화/대면/문자를 한눈에 구분.
const METHOD_CLASS = { '전화': 'method-call', '대면': 'method-visit', '문자': 'method-sms' };

// 학생 마스터에서 학년/대표반 라벨 추출(읽기 전용; 파생 재구현 아님).
function buildStudentInfo(students) {
    const info = {};
    for (const s of students) {
        info[s.id] = {
            gradeLabel: studentShortLabel(s) || '',
            classLabel: [...new Set(allClassCodes(s))].join(', '),
        };
    }
    return info;
}

function Tag({ value, className = '' }) {
    if (!value) return <span className="consult-c-sec">—</span>;
    return <span className={`consult-tag ${className}`}>{value}</span>;
}

export default function ConsultationBoard({
    consultations, students, branchFilter, classFilter, gradeFilter, startDate, endDate,
}) {
    const [groupMode, setGroupMode] = useState('date'); // 'date' | 'student'

    const studentInfo = useMemo(() => buildStudentInfo(students), [students]);

    // 소속/학년/반 필터 → 허용 student id. 필터가 하나도 없으면 전체(null).
    const hasFilter = Boolean(branchFilter || classFilter || gradeFilter?.size);
    const allowedIds = useMemo(() => {
        if (!hasFilter) return null;
        const ids = new Set();
        for (const s of students) {
            if (branchFilter && branchFromStudent(s) !== branchFilter) continue;
            if (gradeFilter?.size && !gradeFilter.has(studentGradeKey(s))) continue;
            if (classFilter && !(s.enrollments || []).some(e => enrollmentCode(e) === classFilter)) continue;
            ids.add(s.id);
        }
        return ids;
    }, [students, branchFilter, classFilter, gradeFilter, hasFilter]);

    const visible = useMemo(
        () => filterByStudentIds(consultations, allowedIds),
        [consultations, allowedIds],
    );

    const groups = useMemo(
        () => (groupMode === 'date' ? groupByDate(visible) : groupByStudent(visible)),
        [groupMode, visible],
    );

    const handleExport = () => {
        downloadCsv(`상담내역_${startDate}_${endDate}.csv`, CONSULTATION_COLUMNS, toCsvRows(visible, studentInfo));
    };

    const gradeClassOf = (c) => {
        const info = studentInfo[c.student_id] || {};
        return [info.gradeLabel, info.classLabel].filter(Boolean).join(' · ');
    };

    return (
        <div className="consult-board">
            <div className="consult-board-bar">
                <span className="dash-view-toggle" role="group" aria-label="묶음 기준">
                    <button type="button" className={groupMode === 'date' ? 'active' : ''} aria-pressed={groupMode === 'date'} onClick={() => setGroupMode('date')}>일자별</button>
                    <button type="button" className={groupMode === 'student' ? 'active' : ''} aria-pressed={groupMode === 'student'} onClick={() => setGroupMode('student')}>학생별</button>
                </span>
                <span className="consult-count">총 {visible.length}건</span>
                <button type="button" className="consult-export" onClick={handleExport} disabled={!visible.length} aria-label="CSV 다운로드">
                    <span className="material-symbols-outlined" aria-hidden="true">download</span>
                    CSV 다운로드
                </button>
            </div>

            {!visible.length ? (
                <div className="consult-empty">
                    <span className="material-symbols-outlined" aria-hidden="true">forum</span>
                    <span>기간 내 상담이 없습니다.</span>
                </div>
            ) : (
                groups.map(group => (
                    <section key={group.studentId || group.key} className="consult-group">
                        <div className="consult-group-head">
                            <strong>{group.key || '(미상)'}</strong>
                            <span className="consult-group-count">{group.items.length}건</span>
                        </div>
                        <div className="consult-table-wrap">
                            <table className="consult-table">
                                <thead>
                                    <tr>
                                        {CONSULTATION_COLUMNS.map(col => <th key={col} scope="col">{col}</th>)}
                                    </tr>
                                </thead>
                                <tbody>
                                    {group.items.map(c => (
                                        <tr key={c.id}>
                                            <td className="consult-c-date">{c.date || ''}</td>
                                            <td className="consult-c-name">{c.student_name || ''}</td>
                                            <td className="consult-c-sec">{gradeClassOf(c) || '—'}</td>
                                            <td className="consult-c-sec">{c.teacher_name || '—'}</td>
                                            <td><Tag value={c.target} className={c.target === '학부모' ? 'target-parent' : ''} /></td>
                                            <td><Tag value={c.method} className={METHOD_CLASS[c.method] || ''} /></td>
                                            <td><Tag value={c.consultation_type} /></td>
                                            <td className="consult-c-title">{c.title || '—'}</td>
                                            <td className="consult-c-memo">{c.text || ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                ))
            )}
        </div>
    );
}
