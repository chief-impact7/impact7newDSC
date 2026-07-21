import { useMemo, useState } from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { ICON_NAME } from '../icon-map.js';
import { allClassCodes } from '../../../student-core.js';
import { studentShortLabel, toDateStrKST, allowedStudentIds } from '../../shared/firestore-helpers.js';
import { renderMarkdown } from '../../../ui-utils.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import {
    buildGroups, teacherOptions, generatedAtMs, isStale,
    countParts, gapLabel,
} from '../lib/ai-status-view.js';

const classLabel = (student) => [...new Set(allClassCodes(student))].join(', ');

function FlagList({ title, items }) {
    if (!Array.isArray(items) || !items.length) return null;
    return (
        <div className="ai-list">
            <strong>{title}</strong>
            <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
    );
}

function AiRow({ student, summary, nowMs }) {
    const parts = countParts(summary);
    const gap = gapLabel(summary);
    const ms = generatedAtMs(summary.generated_at);
    return (
        <details className="ai-row">
            <summary className="ai-row-line">
                <strong>{student.name}</strong>
                <span className="ai-sec">{studentShortLabel(student)}</span>
                <span className="ai-sec">{classLabel(student)}</span>
                {parts.length > 0 && <span className="ai-counts">{parts.join(' · ')}</span>}
                {gap && <span className="ai-gap">{gap}</span>}
                <span className="ai-date">
                    {ms != null ? toDateStrKST(new Date(ms)) : ''}
                    {isStale(summary.generated_at, nowMs) && <span className="ai-stale-badge">오래됨</span>}
                </span>
            </summary>
            <div className="ai-row-body">
                <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.summary_markdown) }} />
                <FlagList title="위험 신호" items={summary.risk_flags} />
                <FlagList title="권장 조치" items={summary.action_items} />
                {summary.attendance_comment && <p className="ai-comment"><strong>출결</strong> {summary.attendance_comment}</p>}
                {summary.hw_comment && <p className="ai-comment"><strong>숙제</strong> {summary.hw_comment}</p>}
                {summary.test_comment && <p className="ai-comment"><strong>테스트</strong> {summary.test_comment}</p>}
                <p className="ai-meta">마지막 생성 {formatDateTimeKST(summary.generated_at)}</p>
            </div>
        </details>
    );
}

export default function AiStatusBoard({
    students, data, loading, error, reload, branchFilter, classFilter, gradeFilter,
}) {
    const [teacherKey, setTeacherKey] = useState('');
    const [search, setSearch] = useState('');
    const nowMs = Date.now();

    const teachers = useMemo(
        () => teacherOptions(data?.classSettings, data?.staffByLocal),
        [data],
    );
    const teacherClassCodes = useMemo(() => {
        if (!teacherKey) return null;
        return teachers.find(t => t.key === teacherKey)?.classCodes || new Set();
    }, [teachers, teacherKey]);

    const allowedIds = useMemo(
        () => allowedStudentIds(students, { branchFilter, classFilter, gradeFilter }),
        [students, branchFilter, classFilter, gradeFilter],
    );

    const groups = useMemo(
        () => buildGroups(students, data?.summaries, { allowedIds, teacherClassCodes, search }),
        [students, data, allowedIds, teacherClassCodes, search],
    );

    if (error) {
        return (
            <div className="ai-error" role="alert">
                <p>AI 종합상태를 불러오지 못했습니다.</p>
                <IconButton icon={ICON_NAME.refresh} label="다시 시도" onClick={reload} />
            </div>
        );
    }
    if (loading && !data) return <div className="dash-loading">로딩 중...</div>;

    const total = groups.reduce((n, g) => n + g.items.length, 0);

    return (
        <div className="ai-board">
            <div className="consult-board-bar">
                <label className="ai-teacher-label" htmlFor="ai-teacher-select">담당</label>
                <select id="ai-teacher-select" aria-label="담당" value={teacherKey}
                    onChange={e => setTeacherKey(e.target.value)}>
                    <option value="">전체</option>
                    {teachers.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
                </select>
                <input type="text" className="consult-search" value={search}
                    placeholder="학생 이름 검색" aria-label="학생 이름 검색"
                    onChange={e => setSearch(e.target.value)} />
                <span className="consult-count">
                    {groups.map(g => `${g.label} ${g.items.length}`).join(' · ')}
                </span>
            </div>

            {!total ? (
                <div className="consult-empty">
                    <Icon name={ICON_NAME.forum} size={40} style={{ opacity: 0.5 }} aria-hidden="true" />
                    <span>{search ? '검색 결과가 없습니다.' : '표시할 학생이 없습니다.'}</span>
                </div>
            ) : (
                groups.map(g => (
                    <details key={g.key} className="ai-group"
                        open={Boolean(search) || g.key === 'risk' || g.key === 'caution'}>
                        <summary className="consult-group-head">
                            <Icon name={ICON_NAME.chevron_right} size={20} className="consult-group-chevron" aria-hidden="true" />
                            <span className={`ai-tone-badge ai-tone-${g.key}`}>{g.label}</span>
                            <span className="consult-group-count">{g.items.length}명</span>
                        </summary>
                        {g.key === 'none' ? (
                            <div className="ai-none-list">
                                <p className="ai-none-hint">AI 분석 미생성 — 생성은 메인앱 학생 상세패널에서 가능합니다.</p>
                                {g.items.map(({ student }) => (
                                    <div key={student.id} className="ai-row-line ai-none-row">
                                        <strong>{student.name}</strong>
                                        <span className="ai-sec">{studentShortLabel(student)}</span>
                                        <span className="ai-sec">{classLabel(student)}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            g.items.map(({ student, summary }) => (
                                <AiRow key={student.id} student={student} summary={summary} nowMs={nowMs} />
                            ))
                        )}
                    </details>
                ))
            )}
        </div>
    );
}
