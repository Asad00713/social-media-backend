import { derivePostStatus, targetStatusOf } from './post-status';

describe('targetStatusOf', () => {
  it('reads published from status', () => {
    expect(targetStatusOf({ status: 'published' }, 'published')).toBe(
      'published',
    );
  });

  it('reads published from publishStatus (composer drift)', () => {
    expect(
      targetStatusOf(
        { status: 'draft', publishStatus: 'published' },
        'partially_published',
      ),
    ).toBe('published');
  });

  it('published wins when the two fields disagree', () => {
    expect(
      targetStatusOf(
        { status: 'failed', publishStatus: 'published' },
        'failed',
      ),
    ).toBe('published');
  });

  it('failed from either field', () => {
    expect(targetStatusOf({ publishStatus: 'failed' }, 'scheduled')).toBe(
      'failed',
    );
  });

  it('retry_pending is publishing', () => {
    expect(
      targetStatusOf({ publishStatus: 'retry_pending' }, 'scheduled'),
    ).toBe('publishing');
  });

  it('post publishing means publishing', () => {
    expect(targetStatusOf({}, 'publishing')).toBe('publishing');
  });

  it('falls back to scheduled / draft', () => {
    expect(targetStatusOf({}, 'scheduled')).toBe('scheduled');
    expect(targetStatusOf({}, 'draft')).toBe('draft');
  });
});

describe('derivePostStatus', () => {
  const published = { status: 'published' };
  const failed = { status: 'failed' };

  it('mixed published and failed is partially_published', () => {
    expect(derivePostStatus('published', [published, failed])).toBe(
      'partially_published',
    );
    expect(derivePostStatus('failed', [published, failed])).toBe(
      'partially_published',
    );
  });

  it('keeps a stored partially_published', () => {
    expect(derivePostStatus('partially_published', [failed, failed])).toBe(
      'partially_published',
    );
  });

  it('leaves uniform and in-flight statuses alone', () => {
    expect(derivePostStatus('published', [published, published])).toBe(
      'published',
    );
    expect(derivePostStatus('publishing', [published, failed])).toBe(
      'publishing',
    );
    expect(derivePostStatus('scheduled', [])).toBe('scheduled');
    expect(derivePostStatus('failed', [failed])).toBe('failed');
    expect(derivePostStatus('draft', [published, failed])).toBe('draft');
  });
});
