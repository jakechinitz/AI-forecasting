import React, { useEffect, useState } from 'react';

// Numeric cell that keeps its own text while typing and commits on blur or
// Enter, so partial entries ("-", "0.") never reach the model. Escape reverts.
export default function NumInput({ value, kind, step, onChange, width = 64 }) {
  const format = (v) => (v == null || Number.isNaN(+v)
    ? ''
    : String(kind === 'pct' ? +(v * 100).toFixed(2) : +(+v).toFixed(4)));
  const [text, setText] = useState(format(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(format(value)); }, [value, kind, editing]);
  const commit = () => {
    setEditing(false);
    const n = parseFloat(text);
    if (Number.isFinite(n)) {
      const next = kind === 'pct' ? n / 100 : n;
      if (next !== value) onChange(next);
    } else {
      setText(format(value));
    }
  };
  return (
    <input
      type="number"
      className="fin-input"
      style={{ width }}
      step={step ?? 1}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setText(format(value)); setEditing(false); e.currentTarget.blur(); }
      }}
    />
  );
}

export function Kpi({ label, value, sub }) {
  return (
    <div className="fin-kpi">
      <div className="fin-kpi-label">{label}</div>
      <div className="fin-kpi-value">{value}</div>
      {sub && <div className="fin-kpi-sub">{sub}</div>}
    </div>
  );
}
