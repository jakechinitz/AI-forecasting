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
            <span className="sidebar-item-text">
              <span className="sidebar-item-label">{tab.label}</span>
            </span>
          </button>
        ))}
      </nav>

      <div style={{ marginTop: 'auto' }}>
        <div className="sidebar-divider" />
        <div style={{ padding: '8px 12px', margin: '0 8px 12px' }}>
          <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span>20yr horizon &middot; Monthly &middot; 30+ nodes</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
