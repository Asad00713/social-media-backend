import {
  isEntityReference,
  isReferencePayload,
  mergeReferences,
  referenceMarker,
  withReferences,
  type EntityReference,
} from './references';

const channel = (id: string, label = `Channel ${id}`): EntityReference => ({
  kind: 'channel',
  id,
  label,
});

describe('references', () => {
  describe('withReferences', () => {
    it('wraps data with its entities', () => {
      const payload = withReferences({ total: 2 }, [
        channel('a'),
        channel('b'),
      ]);

      expect(payload.kind).toBe('refs');
      expect(payload.data).toEqual({ total: 2 });
      expect(payload.refs.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('keeps a status when the entity has one', () => {
      const payload = withReferences(null, [
        { kind: 'post', id: 'p1', label: 'Launch post', status: 'scheduled' },
      ]);

      expect(payload.refs[0].status).toBe('scheduled');
    });

    it('drops duplicate ids so one entity yields one link', () => {
      const payload = withReferences(null, [
        channel('a', 'First label'),
        channel('a', 'Second label'),
      ]);

      expect(payload.refs).toHaveLength(1);
      expect(payload.refs[0].label).toBe('First label');
    });

    it('drops malformed entries rather than passing them through', () => {
      const payload = withReferences(null, [
        channel('good'),
        { kind: 'channel', id: '', label: 'no id' } as EntityReference,
        { kind: 'nonsense', id: 'x', label: 'bad kind' } as never,
      ]);

      expect(payload.refs.map((r) => r.id)).toEqual(['good']);
    });

    it('strips keys outside the documented shape', () => {
      const payload = withReferences(null, [
        { ...channel('a'), secret: 'internal' } as never,
      ]);

      expect(payload.refs[0]).toEqual({
        kind: 'channel',
        id: 'a',
        label: 'Channel a',
      });
    });

    it('produces an empty list, not an absent one, when nothing was found', () => {
      const payload = withReferences({ items: [] }, []);

      expect(payload.refs).toEqual([]);
      expect(isReferencePayload(payload)).toBe(true);
    });
  });

  describe('mergeReferences', () => {
    // Two tools in one turn must both stay clickable — unlike media and
    // questions, where a later result replaces an earlier one.
    it('accumulates across tool calls instead of replacing', () => {
      const merged = mergeReferences(
        [channel('a')],
        [{ kind: 'campaign', id: 'c1', label: 'Summer push' }],
      );

      expect(merged.map((r) => r.id)).toEqual(['a', 'c1']);
    });

    it('does not re-add an entity already referenced', () => {
      const merged = mergeReferences([channel('a')], [channel('a', 'Renamed')]);

      expect(merged).toHaveLength(1);
      expect(merged[0].label).toBe('Channel a');
    });

    it('ignores malformed incoming entries', () => {
      const merged = mergeReferences(
        [channel('a')],
        [null, 'nope', { id: 'b' }],
      );

      expect(merged.map((r) => r.id)).toEqual(['a']);
    });
  });

  describe('isEntityReference', () => {
    it.each([
      ['null', null],
      ['a string', 'channel'],
      ['a missing id', { kind: 'channel', label: 'x' }],
      ['an empty id', { kind: 'channel', id: '', label: 'x' }],
      ['an empty label', { kind: 'channel', id: 'a', label: '' }],
      ['an unknown kind', { kind: 'invoice', id: 'a', label: 'x' }],
      ['a non-string status', { kind: 'post', id: 'a', label: 'x', status: 3 }],
    ])('rejects %s', (_name, value) => {
      expect(isEntityReference(value)).toBe(false);
    });

    it('accepts a well-formed reference', () => {
      expect(isEntityReference(channel('a'))).toBe(true);
    });
  });

  describe('referenceMarker', () => {
    it('is the exact form the model is told to write', () => {
      expect(referenceMarker('abc-123')).toBe('[[ref:abc-123]]');
    });
  });

  describe('isReferencePayload', () => {
    it('rejects other tool payload kinds', () => {
      expect(isReferencePayload({ kind: 'media', items: [] })).toBe(false);
      expect(isReferencePayload({ kind: 'refs' })).toBe(false);
      expect(isReferencePayload(null)).toBe(false);
    });
  });
});
