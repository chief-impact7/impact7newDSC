import React, { useState, useRef, useEffect } from 'react';

const GRADE_GROUPS = [
    { level: '초등', short: '초', grades: ['4', '5', '6'] },
    { level: '중등', short: '중', grades: ['1', '2', '3'] },
    { level: '고등', short: '고', grades: ['1', '2', '3'] },
];

// value: Set<string> (예: {'초6','중1'}), onChange: (Set) => void
// 학부 버튼 3단 토글: 1번=학년 선택 드롭다운, 2번=학부 전체 선택, 3번=학부 전체 해제(→다시 1번)
export default function GradeFilter({ value, onChange }) {
    const [openLevel, setOpenLevel] = useState(null);
    const ref = useRef(null);

    useEffect(() => {
        if (!openLevel) return;
        const onDown = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpenLevel(null);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') setOpenLevel(null);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [openLevel]);

    const toggleGrade = (key) => {
        const next = new Set(value);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onChange(next);
    };

    // value에서 파생: 선택0개+닫힘이면 드롭다운(1번), 전체선택이면 해제(3번), 그 외엔 전체선택(2번).
    const cycleLevel = (level, short, grades) => {
        const selected = grades.filter(g => value.has(short + g)).length;
        if (selected === 0 && openLevel !== level) {
            setOpenLevel(level);
            return;
        }
        setOpenLevel(null);
        const set = new Set(value);
        const selectAll = selected !== grades.length;
        grades.forEach(g => {
            const key = short + g;
            if (selectAll) set.add(key); else set.delete(key);
        });
        onChange(set);
    };

    return (
        <div className="dash-grade-filter" ref={ref}>
            {GRADE_GROUPS.map(({ level, short, grades }) => {
                const active = grades.some(g => value.has(short + g));
                return (
                    <div key={level} className="dash-grade-group">
                        <button
                            type="button"
                            className={`dash-grade-btn${active ? ' active' : ''}`}
                            onClick={() => cycleLevel(level, short, grades)}
                            aria-haspopup="true"
                            aria-expanded={openLevel === level}
                        >
                            {level}
                        </button>
                        {openLevel === level && (
                            <div className="dash-grade-dropdown">
                                {grades.map(g => {
                                    const key = short + g;
                                    return (
                                        <label key={key} className="dash-grade-option">
                                            <input
                                                type="checkbox"
                                                checked={value.has(key)}
                                                onChange={() => toggleGrade(key)}
                                            />
                                            {key}
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
