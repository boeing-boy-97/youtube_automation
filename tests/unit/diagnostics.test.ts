import { describe, expect, it } from 'vitest';
import { describeFinding, worstSeverity, type DiagnosticFinding } from '../../apps/api/src/system/diagnostics.types';

describe('diagnostics findings', () => {
  const ok = describeFinding('jobs.stuck', 'No stuck jobs', 'ok', 'detail', '');
  const info = describeFinding('jobs.recent-failures', 'Recent failures', 'info', 'detail', 'action');
  const warning = describeFinding('queues.failed', 'Failed jobs', 'warning', 'detail', 'action');
  const critical = describeFinding('workers.missing', 'Workers missing', 'critical', 'detail', 'action');

  it('reports the worst severity, not the first one', () => {
    expect(worstSeverity([ok, info])).toBe('info');
    expect(worstSeverity([critical, ok, warning])).toBe('critical');
    expect(worstSeverity([warning, info, ok])).toBe('warning');
  });

  it('treats an all-clear report as ok', () => {
    expect(worstSeverity([ok])).toBe('ok');
    expect(worstSeverity([])).toBe('ok');
  });

  it('keeps every finding actionable: a non-ok finding always carries an action', () => {
    for (const finding of [info, warning, critical]) {
      expect(finding.action.length).toBeGreaterThan(0);
    }
    // An all-clear needs no instruction.
    expect(ok.action).toBe('');
  });

  it('preserves extra evidence (counts, ages, samples) without dropping the required fields', () => {
    const withEvidence: DiagnosticFinding = describeFinding('publishing.stuck', 'Stalled', 'critical', 'detail', 'action', {
      count: 3,
      oldestSeconds: 640,
      samples: [{ id: 'job-1' }],
    });
    expect(withEvidence.count).toBe(3);
    expect(withEvidence.oldestSeconds).toBe(640);
    expect(withEvidence.samples).toHaveLength(1);
    expect(withEvidence.title).toBe('Stalled');
  });
});
