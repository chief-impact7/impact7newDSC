import React, { useState, useRef, useEffect } from 'react';

const GRADE_GROUPS = [
    { level: '초등', short: '초', grades: ['4', '5', '6'] },
    { level: '중등', short: '중', grades: ['1', '2', '3'] },
    { level: '고등', short: '고', grades: ['1', '2', '3'] },
];

// value: Set<string> (예: {'초6','중1'}), onChange: (Set) => void
export default function GradeFilter({ value, onChange }) {
    const [openLevel, setOpenLevel] = useState(null);
    const ref = useRef(null);

    useEffect(() => {
        if (!openLevel) return;
        const onDown = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpenLevel(null);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [openLevel]);

    const toggleGrade = (key) => {
        const next = new Set(value);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onChange(next);
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
                            onClick={() => setOpenLevel(openLevel === level ? null : level)}
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
