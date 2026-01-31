import React, { useMemo } from 'react';
import { formatMonth, formatNumber } from '../engine/calculations.js';

function PrintoutTab({ results }) {
  const snapshot = useMemo(() => {
    if (!results) return null;
    const monthIndex = 12;
    const gpu = results.nodes.gpu_datacenter;
    const hbm = results.nodes.hbm_stacks;
    const cowos = results.nodes.cowos_capacity;

    return {
      asOf: formatMonth(monthIndex),
      gpuTightness: gpu?.tightness?.[monthIndex] ?? 1,
      hbmTightness: hbm?.tightness?.[monthIndex] ?? 1,
      cowosTightness: cowos?.tightness?.[monthIndex] ?? 1,
      gpuDemand: gpu?.demand?.[monthIndex] ?? 0,
      gpuSupply: gpu?.supplyPotential?.[monthIndex] ?? 0
    };
  }, [results]);

  if (!snapshot) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Loading snapshot...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Printout Snapshot</h1>
          <p className="tab-description">
            Quick export-ready view of year-one market tightness and GPU fundamentals.
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ gap: 'var(--space-md)' }}>
        <div className="card">
          <div className="metric">
            <span className="metric-value">{snapshot.asOf}</span>
            <span className="metric-label">Snapshot Date</span>
          </div>
        </div>
        <div className="card">
          <div className="metric">
            <span className="metric-value">{snapshot.gpuTightness.toFixed(2)}</span>
            <span className="metric-label">GPU Tightness</span>
          </div>
        </div>
        <div className="card">
          <div className="metric">
            <span className="metric-value">{snapshot.hbmTightness.toFixed(2)}</span>
            <span className="metric-label">HBM Tightness</span>
          </div>
        </div>
        <div className="card">
          <div className="metric">
            <span className="metric-value">{snapshot.cowosTightness.toFixed(2)}</span>
            <span className="metric-label">CoWoS Tightness</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">GPU Supply/Demand Snapshot</h3>
        </div>
        <div className="grid grid-2" style={{ gap: 'var(--space-lg)' }}>
          <div>
            <div className="metric">
              <span className="metric-value">{formatNumber(snapshot.gpuDemand)}</span>
              <span className="metric-label">GPU Demand (units/mo)</span>
            </div>
          </div>
          <div>
            <div className="metric">
              <span className="metric-value">{formatNumber(snapshot.gpuSupply)}</span>
              <span className="metric-label">GPU Supply Potential (units/mo)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PrintoutTab;
