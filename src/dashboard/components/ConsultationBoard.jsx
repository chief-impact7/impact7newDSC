import { useMemo, useState } from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { ICON_SVG } from '../icon-map.js';
import { branchFromStudent, enrollmentCode, allClassCodes } from '../../../student-core.js';
import { studentGradeKey, studentShortLabel } from '../../shared/firestore-helpers.js';
import { downloadCsv } from '../../shared/csv.js';
import {
    filterByStudentIds, groupByDate, groupByStudent, groupByTeacher,
    filterGroupsByKeyword, toCsvRows, teacherLabel, CONSULTATION_COLUMNS,
} from '../lib/consultation-view.js';

// 상담 형태별 배지 색 — 전화/대면/문자를 한눈에 구분.
const METHOD_CLASS = { '전화': 'method-call', '대면': 'method-visit', '문자': 'method-sms' };

const MODES = [
    { key: 'date', label: '일자별', unit: '일' },
    { key: 'student', label: '학생별', unit: '명', searchPlaceholder: '학생 이름 검색' },
    { key: 'teacher', label: '상담자별', unit: '명', searchPlaceholder: '상담자 이름 검색' },
];

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
    const [groupMode, setGroupMode] = useState('student');
    const [search, setSearch] = useState('');

    const studentInfo = useMemo(() => buildStudentInfo(students), [students]);
    const mode = MODES.find(m => m.key === groupMode);
    const canSearch = groupMode !== 'date';

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

    const groups = useMemo(() => {
        const g = groupMode === 'date' ? groupByDate(visible)
            : groupMode === 'student' ? groupByStudent(visible)
            : groupByTeacher(visible);
        return canSearch ? filterGroupsByKeyword(g, search) : g;
    }, [groupMode, visible, search, canSearch]);

    const exportRows = useMemo(() => groups.flatMap(g => g.items), [groups]);

    const changeMode = (m) => { setGroupMode(m); setSearch(''); };

    const handleExport = () => {
        downloadCsv(`상담내역_${startDate}_${endDate}.csv`, CONSULTATION_COLUMNS, toCsvRows(exportRows, studentInfo));
    };

    const gradeClassOf = (c) => {
        const info = studentInfo[c.student_id] || {};
        return [info.gradeLabel, info.classLabel].filter(Boolean).join(' · ');
    };

    return (
        <div className="consult-board">
            <div className="consult-board-bar">
                <span className="dash-view-toggle" role="group" aria-label="묶음 기준">
                    {MODES.map(m => (
                        <button key={m.key} type="button" className={groupMode === m.key ? 'active' : ''}
                            aria-pressed={groupMode === m.key} onClick={() => changeMode(m.key)}>{m.label}</button>
                    ))}
                </span>
                {canSearch && (
                    <input type="text" className="consult-search" value={search}
                        placeholder={mode.searchPlaceholder} aria-label={mode.searchPlaceholder}
                        onChange={e => setSearch(e.target.value)} />
                )}
                <span className="consult-count">총 {exportRows.length}건 · {groups.length}{mode.unit}</span>
                <IconButton style={{ marginLeft: 'auto' }} svg={ICON_SVG.download} label="CSV 다운로드" onClick={handleExport} disabled={!exportRows.length} />
            </div>

            {!groups.length ? (
                <div className="consult-empty">
                    <Icon svg={ICON_SVG.forum} size={40} style={{ opacity: 0.5 }} aria-hidden="true" />
                    <span>{search ? '검색 결과가 없습니다.' : '기간 내 상담이 없습니다.'}</span>
                </div>
            ) : (
                groups.map(group => (
                    <details key={group.studentId || group.key} className="consult-group" open={Boolean(search)}>
                        <summary className="consult-group-head">
                            <Icon svg={ICON_SVG.chevron_right} size={20} className="consult-group-chevron" aria-hidden="true" />
                            <strong>{group.key || '(미상)'}</strong>
                            <span className="consult-group-count">{group.items.length}건</span>
                        </summary>
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
                                            <td className="consult-c-sec">{teacherLabel(c) || '—'}</td>
                                            <td><Tag value={c.target} className={c.target === '학부모' ? 'target-parent' : ''} /></td>
                                            <td><Tag value={c.method} className={METHOD_CLASS[c.method] || ''} /></td>
                                            <td><Tag value={c.consultation_type} /></td>
                                            <td className="consult-c-title">{c.title || '—'}</td>
                                            <td className="consult-c-memo dash-detail-content">{c.text || ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </details>
                ))
            )}
        </div>
    );
}
