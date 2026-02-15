import React, { useState, useMemo } from 'react';
import { NODE_GROUPS } from '../data/nodes.js';

function NodeLibraryTab({ nodes, groups: groupsProp, selectedNode, onSelectNode }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [activeGroup, setActiveGroup] = useState(null);
  const [expandedNode, setExpandedNode] = useState(null);

  // Convert array-format NODE_GROUPS to object keyed by group id
  const groups = useMemo(() => {
    if (Array.isArray(groupsProp)) {
      return groupsProp.reduce((acc, g) => { acc[g.id] = g; return acc; }, {});
    }
    return groupsProp;
  }, [groupsProp]);

  const filteredNodes = useMemo(() => {
    return nodes.filter(node => {
      const matchesSearch = node.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           node.id.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesGroup = !activeGroup || node.group === activeGroup;
      return matchesSearch && matchesGroup;
    });
  }, [nodes, searchTerm, activeGroup]);

  const getGroupColor = (groupId) => {
    return groups[groupId]?.color || '#6366f1';
  };

  const getConfidenceIndicator = (confidence) => {
    switch (confidence) {
      case 'high': return { symbol: '●', color: 'var(--accent-success)' };
      case 'medium': return { symbol: '◐', color: 'var(--accent-warning)' };
      case 'low': return { symbol: '○', color: 'var(--text-muted)' };
      default: return { symbol: '○', color: 'var(--text-muted)' };
    }
  };

  const formatElasticity = (value) => {
    if (value === undefined || value === null) return '-';
    if (value < 0.1) return 'Very Low';
    if (value < 0.3) return 'Low';
    if (value < 0.6) return 'Moderate';
    if (value < 0.8) return 'High';
    return 'Very High';
  };

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Node Library</h1>
          <p className="tab-description">
            Complete supply chain node graph with {nodes.length} nodes across {Object.keys(groups).length} groups.
            Each node defines demand translation, supply dynamics, and market mechanics.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
        <input
          type="text"
          placeholder="Search nodes..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ flex: 1, maxWidth: '300px' }}
        />

        <div className="group-filters">
          <button
            className={`group-filter ${!activeGroup ? 'active' : ''}`}
            onClick={() => setActiveGroup(null)}
          >
            All
          </button>
          {Object.entries(groups).map(([id, group]) => (
            <button
              key={id}
              className={`group-filter ${activeGroup === id ? 'active' : ''}`}
              style={{ color: group.color }}
              onClick={() => setActiveGroup(activeGroup === id ? null : id)}
            >
              <span className="group-filter-dot" style={{ background: group.color }} />
              {group.name}
            </button>
          ))}
        </div>
      </div>

      {/* Node Table */}
      <div className="card">
        <div className="table-container" style={{ maxHeight: '600px', overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '120px' }}>Group</th>
                <th>Node</th>
                <th>Unit</th>
                <th style={{ width: '100px' }}>Base Capacity</th>
                <th style={{ width: '80px' }}>Lead Time</th>
                <th style={{ width: '100px' }}>Elasticity (S/M/L)</th>
                <th style={{ width: '80px' }}>Substitution</th>
                <th style={{ width: '60px' }}>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {filteredNodes.map(node => (
                <React.Fragment key={node.id}>
                  <tr
                    onClick={() => {
                      onSelectNode(node.id);
                      setExpandedNode(expandedNode === node.id ? null : node.id);
                    }}
                    style={{ cursor: 'pointer' }}
                    className={selectedNode === node.id ? 'selected' : ''}
                  >
                    <td>
                      <span
                        className="node-group-badge"
                        style={{
                          background: getGroupColor(node.group) + '14',
                          color: getGroupColor(node.group),
                          borderColor: getGroupColor(node.group) + '30'
                        }}
                      >
                        <span className="node-group-dot" style={{ background: getGroupColor(node.group) }} />
                        {groups[node.group]?.name || node.group}
                      </span>
                    </td>
                    <td className="text-cell">
                      <div style={{ fontWeight: 500 }}>{node.name}</div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                        {node.id}
                      </div>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {node.unit}
                    </td>
                    <td>
                      {node.startingCapacity
                        ? formatNumber(node.startingCapacity)
                        : '-'}
                    </td>
                    <td>
                      {node.leadTimeNewBuild
                        ? `${node.leadTimeNewBuild}mo`
                        : '-'}
                    </td>
                    <td style={{ fontSize: '0.75rem' }}>
                      {node.elasticityShort !== undefined ? (
                        <span>
                          <span style={{ color: 'var(--status-tight)' }}>
                            {node.elasticityShort?.toFixed(2)}
                          </span>
                          {' / '}
                          <span style={{ color: 'var(--status-stressed)' }}>
                            {node.elasticityMid?.toFixed(2)}
                          </span>
                          {' / '}
                          <span style={{ color: 'var(--status-balanced)' }}>
                            {node.elasticityLong?.toFixed(2)}
                          </span>
                        </span>
                      ) : '-'}
                    </td>
                    <td>
                      {node.substitutabilityScore !== undefined
                        ? (node.substitutabilityScore * 100).toFixed(0) + '%'
                        : '-'}
                    </td>
                    <td>
                      {node.baseRate?.confidence && (
                        <span
                          style={{ color: getConfidenceIndicator(node.baseRate.confidence).color }}
                          title={`Confidence: ${node.baseRate.confidence}`}
                        >
                          {getConfidenceIndicator(node.baseRate.confidence).symbol}
                        </span>
                      )}
                    </td>
                  </tr>

                  {/* Expanded details */}
                  {expandedNode === node.id && (
                    <tr>
                      <td colSpan={8} style={{ padding: 0 }}>
                        <div style={{
                          padding: 'var(--space-md)',
                          background: 'var(--bg-tertiary)',
                          borderTop: '1px solid var(--bg-elevated)'
                        }}>
                          <div className="grid grid-4" style={{ gap: 'var(--space-lg)' }}>
                            {/* Basic Info */}
                            <div>
                              <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                                DESCRIPTION
                              </h4>
                              <p style={{ fontSize: '0.8125rem', margin: 0 }}>
                                {node.description || 'No description available'}
                              </p>

                              {node.baseRate?.source && (
                                <div style={{ marginTop: 'var(--space-sm)' }}>
                                  <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                    Source: {node.baseRate.source}
                                  </span>
                                </div>
                              )}
                            </div>

                            {/* Supply Dynamics */}
                            <div>
                              <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                                SUPPLY DYNAMICS
                              </h4>
                              <div style={{ fontSize: '0.8125rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  <span>Ramp Profile:</span>
                                  <span style={{ fontFamily: 'var(--font-mono)' }}>{node.rampProfile || '-'}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  <span>Debottleneck:</span>
                                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                                    {node.leadTimeDebottleneck ? `${node.leadTimeDebottleneck}mo` : '-'}
                                  </span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  <span>Max Utilization:</span>
                                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                                    {node.maxCapacityUtilization ? `${(node.maxCapacityUtilization * 100).toFixed(0)}%` : '-'}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Yield Model */}
                            <div>
                              <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                                YIELD MODEL
                              </h4>
                              <div style={{ fontSize: '0.8125rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  <span>Type:</span>
                                  <span style={{ fontFamily: 'var(--font-mono)' }}>{node.yieldModel || 'simple'}</span>
                                </div>
                                {node.yieldModel === 'stacked' ? (
                                  <>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                      <span>Initial:</span>
                                      <span style={{ fontFamily: 'var(--font-mono)' }}>
                                        {((node.yieldInitial || 0.65) * 100).toFixed(0)}%
                                      </span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                      <span>Target:</span>
                                      <span style={{ fontFamily: 'var(--font-mono)' }}>
                                        {((node.yieldTarget || 0.85) * 100).toFixed(0)}%
                                      </span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                      <span>Halflife:</span>
                                      <span style={{ fontFamily: 'var(--font-mono)' }}>
                                        {node.yieldHalflifeMonths || 18}mo
                                      </span>
                                    </div>
                                  </>
                                ) : (
                                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>Loss:</span>
                                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                                      {((node.yieldSimpleLoss || 0.03) * 100).toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Risk Factors */}
                            <div>
                              <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                                RISK FACTORS
                              </h4>
                              <div style={{ fontSize: '0.8125rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  <span>Geo Risk:</span>
                                  <span style={{
                                    fontFamily: 'var(--font-mono)',
                                    color: node.geoRiskFlag ? 'var(--accent-warning)' : 'var(--text-muted)'
                                  }}>
                                    {node.geoRiskFlag ? 'Yes' : 'No'}
                                  </span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                  <span>Export Control:</span>
                                  <span style={{
                                    fontFamily: 'var(--font-mono)',
                                    color: node.exportControlSensitivity === 'critical' ? 'var(--accent-danger)' :
                                           node.exportControlSensitivity === 'high' ? 'var(--accent-warning)' :
                                           'var(--text-muted)'
                                  }}>
                                    {node.exportControlSensitivity || 'low'}
                                  </span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                  <span>Concentration:</span>
                                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                                    {node.supplierConcentration || '-'}/5
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Committed Expansions */}
                          {node.committedExpansions && node.committedExpansions.length > 0 && (
                            <div style={{ marginTop: 'var(--space-md)' }}>
                              <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                                COMMITTED EXPANSIONS
                              </h4>
                              <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
                                {node.committedExpansions.map((exp, i) => (
                                  <span
                                    key={i}
                                    style={{
                                      padding: '4px 8px',
                                      background: exp.type === 'committed' ? 'var(--bg-elevated)' : 'transparent',
                                      border: `1px solid ${exp.type === 'committed' ? 'var(--accent-success)' : 'var(--text-muted)'}`,
                                      borderRadius: 'var(--radius-sm)',
                                      fontSize: '0.75rem',
                                      fontFamily: 'var(--font-mono)'
                                    }}
                                  >
                                    {exp.date}: +{formatNumber(exp.capacityAdd)}
                                    {exp.type !== 'committed' && ' (optional)'}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatNumber(num) {
  if (num >= 1e12) return (num / 1e12).toFixed(1) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return num.toString();
}

export default NodeLibraryTab;
