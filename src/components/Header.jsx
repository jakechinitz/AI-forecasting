import React from 'react';

function Header({ stats, scenario, isSimulating }) {
  const getTightnessColor = (value) => {
    const num = parseFloat(value);
    if (isNaN(num)) return 'var(--text-muted)';
    if (num > 1.2) return 'var(--status-tight)';
    if (num > 1.05) return 'var(--status-stressed)';
    if (num > 0.95) return 'var(--status-balanced)';
    if (num > 0.8) return 'var(--status-soft)';
    return 'var(--status-glut)';
  };

  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">
          <div className="logo-icon">⚡</div>
          <div>
            <div className="logo-text">AI Infrastructure Forecast</div>
            <div className="logo-subtitle">Supply Chain Model</div>
          </div>
        </div>

        {stats && (
          <div className="header-stats">
            <div className="header-stat">
              <span
                className="header-stat-value"
                style={{ color: getTightnessColor(stats.gpuTightness) }}
              >
                {stats.gpuTightness}
              </span>
              <span className="header-stat-label">GPU Tightness</span>
            </div>
            <div className="header-stat">
              <span
                className="header-stat-value"
                style={{ color: getTightnessColor(stats.hbmTightness) }}
              >
                {stats.hbmTightness}
              </span>
              <span className="header-stat-label">HBM Tightness</span>
            </div>
            <div className="header-stat">
              <span
                className="header-stat-value"
                style={{ color: getTightnessColor(stats.cowosTightness) }}
              >
                {stats.cowosTightness}
              </span>
              <span className="header-stat-label">CoWoS Tightness</span>
            </div>
            <div className="header-stat">
              <span className="header-stat-value" style={{ color: 'var(--status-tight)' }}>
                {stats.shortages}
              </span>
              <span className="header-stat-label">Shortages</span>
            </div>
            <div className="header-stat">
              <span className="header-stat-value" style={{ color: 'var(--status-glut)' }}>
                {stats.gluts}
              </span>
              <span className="header-stat-label">Gluts</span>
            </div>
          </div>
        )}
      </div>

      <div className="header-right">
        <div className={`scenario-badge ${isSimulating ? 'simulating' : ''}`}>
          <span className="scenario-badge-dot" />
          <span>{scenario?.name || 'Base Case'}</span>
        </div>
      </div>
    </header>
  );
}

export default Header;
