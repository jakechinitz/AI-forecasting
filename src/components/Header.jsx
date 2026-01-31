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
          <div className="logo-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <div>
            <div className="logo-text">AI Infrastructure Forecast</div>
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
              <span className="header-stat-label">GPU</span>
            </div>
            <div className="header-stat">
              <span
                className="header-stat-value"
                style={{ color: getTightnessColor(stats.hbmTightness) }}
              >
                {stats.hbmTightness}
              </span>
              <span className="header-stat-label">HBM</span>
            </div>
            <div className="header-stat">
              <span
                className="header-stat-value"
                style={{ color: getTightnessColor(stats.cowosTightness) }}
              >
                {stats.cowosTightness}
              </span>
              <span className="header-stat-label">CoWoS</span>
            </div>
            <div className="header-stat">
              <span className="header-stat-value" style={{ color: 'var(--status-tight)' }}>
                {stats.shortages}
              </span>
              <span className="header-stat-label">Short</span>
            </div>
            <div className="header-stat">
              <span className="header-stat-value" style={{ color: 'var(--status-glut)' }}>
                {stats.gluts}
              </span>
              <span className="header-stat-label">Glut</span>
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
