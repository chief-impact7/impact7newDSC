import { useMemo, useState } from 'react';
import { branchFromStudent, enrollmentCode, allClassCodes } from '../../../student-core.js';
import { studentGradeKey, studentShortLabel } from '../../shared/firestore-helpers.js';
import { downloadCsv } from '../../shared/csv.js';
import {
    filterByStudentIds, groupByDate, groupByStudent, toRow, toCsvRows, CONSULTATION_COLUMNS,
} from '../lib/consultation-view.js';

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

    return (
        <div className="consult-board">
            <div className="consult-board-bar" style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0' }}>
                <div className="consult-group-toggle" role="group" aria-label="묶음 기준">
                    <button type="button" aria-pressed={groupMode === 'date'} onClick={() => setGroupMode('date')}>일자별</button>
                    <button type="button" aria-pressed={groupMode === 'student'} onClick={() => setGroupMode('student')}>학생별</button>
                </div>
                <span style={{ color: 'var(--text-sec)' }}>총 {visible.length}건</span>
                <button type="button" className="dash-text-btn" style={{ marginLeft: 'auto' }}
                    onClick={handleExport} disabled={!visible.length} aria-label="CSV 다운로드">
                    CSV 다운로드
                </button>
            </div>

            {!visible.length ? (
                <div className="consult-empty" style={{ padding: 20, color: 'var(--text-sec)' }}>기간 내 상담 없음</div>
            ) : (
                groups.map(group => (
                    <section key={group.studentId || group.key} className="consult-group" style={{ marginBottom: 18 }}>
                        <h4 style={{ margin: '8px 0' }}>{group.key || '(미상)'} <small>({group.items.length}건)</small></h4>
                        <table className="consult-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    {CONSULTATION_COLUMNS.map(col => (
                                        <th key={col} scope="col" style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: '4px 6px', whiteSpace: 'nowrap' }}>{col}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {group.items.map(c => {
                                    const cells = toRow(c, studentInfo);
                                    return (
                                        <tr key={c.id}>
                                            {cells.map((cell, i) => (
                                                <td key={i} style={{
                                                    borderBottom: '1px solid var(--border)', padding: '4px 6px',
                                                    whiteSpace: i === cells.length - 1 ? 'pre-wrap' : 'nowrap',
                                                    verticalAlign: 'top',
                                                }}>{cell}</td>
                                            ))}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </section>
                ))
            )}
        </div>
    );
}
