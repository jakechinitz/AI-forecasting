import React from 'react';

function Sidebar({ tabs, activeTab, onTabChange }) {
  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`sidebar-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            <span className="sidebar-item-icon">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />

      <div className="sidebar-nav">
        <div style={{ padding: '0 var(--space-md)', marginBottom: 'var(--space-sm)' }}>
          <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Model Info
          </span>
        </div>
        <div style={{ padding: '0 var(--space-md)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          <div style={{ marginBottom: 'var(--space-xs)' }}>
            <strong>Horizon:</strong> 20 years
          </div>
          <div style={{ marginBottom: 'var(--space-xs)' }}>
            <strong>Resolution:</strong> Monthly
          </div>
          <div>
            <strong>Nodes:</strong> 30+
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
