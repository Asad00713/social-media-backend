import { resolveAgentAuth, MaestroAuthUnavailableError } from './agent-auth';

/**
 * These guard the credential decision that bills real money: which Anthropic
 * key a Maestro run uses, and whether that run is billable to the workspace.
 */
describe('resolveAgentAuth', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Fresh copy per test so mutations never leak between cases.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.MAESTRO_AUTH_MODE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('default (apiKey) mode', () => {
    it('uses the platform key when no mode is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';

      const auth = resolveAgentAuth();

      expect(auth.mode).toBe('apiKey');
      expect(auth.keySource).toBe('platform');
      expect(auth.env.ANTHROPIC_API_KEY).toBe('sk-ant-platform');
    });

    it('throws a typed error when no key is configured at all', () => {
      expect(() => resolveAgentAuth()).toThrow(MaestroAuthUnavailableError);
    });

    it('treats a whitespace-only key as missing', () => {
      process.env.ANTHROPIC_API_KEY = '   ';

      expect(() => resolveAgentAuth()).toThrow(MaestroAuthUnavailableError);
    });

    it('tags the run as billable to the platform', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';

      expect(resolveAgentAuth().keySource).toBe('platform');
    });
  });

  describe('BYOK', () => {
    it('prefers the workspace key over the platform key', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';

      const auth = resolveAgentAuth({ workspaceApiKey: 'sk-ant-workspace' });

      expect(auth.env.ANTHROPIC_API_KEY).toBe('sk-ant-workspace');
      expect(auth.keySource).toBe('byok');
    });

    it('works with no platform key configured', () => {
      const auth = resolveAgentAuth({ workspaceApiKey: 'sk-ant-workspace' });

      expect(auth.mode).toBe('apiKey');
      expect(auth.keySource).toBe('byok');
    });

    it('falls back to the platform key when the workspace key is blank', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';

      const auth = resolveAgentAuth({ workspaceApiKey: '  ' });

      expect(auth.env.ANTHROPIC_API_KEY).toBe('sk-ant-platform');
      expect(auth.keySource).toBe('platform');
    });

    it('falls back to the platform key when the workspace key is null', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';

      expect(resolveAgentAuth({ workspaceApiKey: null }).keySource).toBe(
        'platform',
      );
    });
  });

  describe('subscription mode', () => {
    it('strips the API key so the subprocess uses Claude Code OAuth', () => {
      process.env.MAESTRO_AUTH_MODE = 'subscription';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';

      const auth = resolveAgentAuth();

      expect(auth.mode).toBe('subscription');
      expect(auth.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('is refused in production', () => {
      process.env.MAESTRO_AUTH_MODE = 'subscription';
      process.env.NODE_ENV = 'production';

      expect(() => resolveAgentAuth()).toThrow(MaestroAuthUnavailableError);
    });

    it('never reports byok, even with a workspace key present', () => {
      process.env.MAESTRO_AUTH_MODE = 'subscription';

      const auth = resolveAgentAuth({ workspaceApiKey: 'sk-ant-workspace' });

      expect(auth.keySource).toBe('platform');
    });
  });

  describe('production safety', () => {
    it('still resolves the platform key in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';

      expect(resolveAgentAuth().mode).toBe('apiKey');
    });

    it('throws in production when the key is missing', () => {
      process.env.NODE_ENV = 'production';

      expect(() => resolveAgentAuth()).toThrow(MaestroAuthUnavailableError);
    });
  });
});
