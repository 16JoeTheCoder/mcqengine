import { describe, expect, it } from 'vitest';
import { SET_LIMITS, setPatch } from '../../src/screens/edit-set';

const ok = { title: 'Chemistry', subject: 'Chemistry', description: 'Notes', examDate: '' };

describe('setPatch', () => {
  it('rejects an empty or blank title', () => {
    expect(setPatch({ ...ok, title: '' })).toHaveProperty('error');
    expect(setPatch({ ...ok, title: '   ' })).toHaveProperty('error');
  });
  it('rejects fields over their limits and accepts them at the limit', () => {
    expect(setPatch({ ...ok, title: 'x'.repeat(SET_LIMITS.title + 1) })).toHaveProperty('error');
    expect(setPatch({ ...ok, subject: 'x'.repeat(SET_LIMITS.subject + 1) })).toHaveProperty('error');
    expect(setPatch({ ...ok, description: 'x'.repeat(SET_LIMITS.description + 1) })).toHaveProperty('error');
    expect(setPatch({ ...ok, title: 'x'.repeat(SET_LIMITS.title), subject: 'x'.repeat(SET_LIMITS.subject), description: 'x'.repeat(SET_LIMITS.description) })).not.toHaveProperty('error');
  });
  it('measures length after trimming', () => {
    expect(setPatch({ ...ok, subject: ` ${'x'.repeat(SET_LIMITS.subject)} ` })).not.toHaveProperty('error');
  });
  it('rejects a malformed exam date and keeps a good one', () => {
    for (const d of ['tomorrow', '2026-1-5', '05/01/2026', '2026-01-05T00:00']) expect(setPatch({ ...ok, examDate: d }), d).toHaveProperty('error');
    expect(setPatch({ ...ok, examDate: '2026-05-04' })).toMatchObject({ examDate: '2026-05-04' });
  });
  it('trims fields and leaves out an empty exam date', () => {
    const p = setPatch({ title: '  Physics  ', subject: ' AS ', description: '\n Notes \n', examDate: '' });
    expect(p).toEqual({ title: 'Physics', subject: 'AS', description: 'Notes' });
    expect(p).not.toHaveProperty('examDate');
  });
});
