import { describe, expect, it } from 'vitest';
import {
  JOB_STATES,
  JOB_TRANSITIONS,
  PIPELINE_STATES,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  type JobState,
} from '@clipforge/shared-types';

describe('job state machine', () => {
  it('declares a transition list for every state', () => {
    for (const state of JOB_STATES) expect(JOB_TRANSITIONS[state]).toBeDefined();
  });

  it('only references known states in every transition list', () => {
    for (const state of JOB_STATES) {
      for (const target of JOB_TRANSITIONS[state]) expect(JOB_STATES).toContain(target);
    }
  });

  it('walks the documented happy path in order', () => {
    for (let index = 0; index < PIPELINE_STATES.length - 1; index += 1) {
      const from = PIPELINE_STATES[index];
      const to = PIPELINE_STATES[index + 1];
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('lets a render-only workflow finish from ASSET_STORAGE', () => {
    // Regression: manual publishing used to dead-end because ASSET_STORAGE could not reach COMPLETED.
    expect(canTransition('ASSET_STORAGE', 'COMPLETED')).toBe(true);
    expect(canTransition('ASSET_STORAGE', 'PUBLISHING_QUEUED')).toBe(true);
  });

  it('treats COMPLETED and CANCELLED as absorbing states', () => {
    expect(JOB_TRANSITIONS.COMPLETED).toEqual([]);
    expect(JOB_TRANSITIONS.CANCELLED).toEqual([]);
    for (const state of JOB_STATES) {
      if (state === 'COMPLETED' || state === 'CANCELLED') continue;
      expect(canTransition('COMPLETED', state)).toBe(false);
      expect(canTransition('CANCELLED', state)).toBe(false);
    }
  });

  it('allows RETRYING from every state that has started work', () => {
    const retryable = JOB_STATES.filter(
      (state: JobState) => state !== 'CREATED' && state !== 'COMPLETED' && state !== 'CANCELLED' && state !== 'RETRYING',
    );
    for (const state of retryable) expect(canTransition(state, 'RETRYING'), `${state} -> RETRYING`).toBe(true);
    // A job that never started has nothing to resume: it is queued or cancelled instead.
    expect(canTransition('CREATED', 'RETRYING')).toBe(false);
    expect(canTransition('CREATED', 'QUEUED')).toBe(true);
    // RETRYING must resume at a real pipeline stage, never loop on itself or jump to the end.
    expect(canTransition('RETRYING', 'RETRYING')).toBe(false);
    expect(canTransition('RETRYING', 'CREATED')).toBe(false);
    expect(canTransition('RETRYING', 'COMPLETED')).toBe(false);
    expect(canTransition('RETRYING', 'RENDERING')).toBe(true);
  });

  it('never allows skipping the render stage to reach VALIDATION', () => {
    expect(canTransition('AI_ANALYSIS', 'VALIDATION')).toBe(false);
    expect(canTransition('RENDERING', 'VALIDATION')).toBe(true);
  });

  it('exposes exactly the terminal states the API reports as final', () => {
    const terminal = JOB_STATES.filter((state: JobState) => isTerminal(state));
    expect(terminal.sort()).toEqual([...TERMINAL_STATES].sort());
    expect(terminal).not.toContain('RETRYING');
    expect(terminal).not.toContain('PUBLISHING');
  });

  it('rejects unknown transitions', () => {
    expect(canTransition('CREATED', 'RENDERING')).toBe(false);
    expect(canTransition('PROBING', 'PUBLISHING')).toBe(false);
  });
});

describe('RETRYING is never a dead end', () => {
  it('allows a job stuck in RETRYING to fail, cancel or wait for configuration', () => {
    // A retry that cannot be planned (resume point missing) or whose budget is exhausted while it
    // sits in RETRYING must be able to leave that state — otherwise it is stranded forever.
    expect(canTransition('RETRYING', 'FAILED')).toBe(true);
    expect(canTransition('RETRYING', 'CANCELLED')).toBe(true);
    expect(canTransition('RETRYING', 'NEEDS_CONFIGURATION')).toBe(true);
    expect(canTransition('RETRYING', 'PROBING')).toBe(true);
    expect(canTransition('RETRYING', 'RENDERING')).toBe(true);
  });
});
