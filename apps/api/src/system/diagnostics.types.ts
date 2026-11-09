import type { ComponentHealth } from './system.service';

/**
 * Diagnostics: the questions an operator actually asks when something looks wrong at 2am.
 *
 *   - is anything stuck, and since when?
 *   - is the outbox draining?
 *   - are credentials about to expire?
 *   - is the disk going to fill up?
 *
 * Each finding carries a severity and a recommended action, so the endpoint is actionable rather
 * than a wall of numbers. Nothing here is inferred: every count comes from a real query and every
 * threshold is stated in the finding itself.
 */
export type DiagnosticSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface DiagnosticFinding {
  id: string;
  title: string;
  severity: DiagnosticSeverity;
  detail: string;
  /** What the operator should do. Empty for `ok` findings. */
  action: string;
  count?: number;
  oldestSeconds?: number;
  samples?: Array<Record<string, unknown>>;
}

export interface DiagnosticsReport {
  generatedAt: string;
  version: string;
  uptimeSeconds: number;
  worst: DiagnosticSeverity;
  findings: DiagnosticFinding[];
  components: ComponentHealth[];
  environment: {
    nodeEnv: string;
    timezone: string;
    storageDriver: string;
    jobLeaseSeconds: number;
    workerConcurrency: Record<string, number>;
  };
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };

export function worstSeverity(findings: DiagnosticFinding[]): DiagnosticSeverity {
  return findings.reduce<DiagnosticSeverity>(
    (worst, finding) => (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[worst] ? finding.severity : worst),
    'ok',
  );
}

/** A finding is only worth reporting once it has names, counts and an age. */
export function describeFinding(
  id: string,
  title: string,
  severity: DiagnosticSeverity,
  detail: string,
  action: string,
  extras: Partial<DiagnosticFinding> = {},
): DiagnosticFinding {
  return { id, title, severity, detail, action, ...extras };
}
