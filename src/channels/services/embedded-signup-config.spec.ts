import { readEmbeddedSignupConfig } from './embedded-signup-config';

describe('readEmbeddedSignupConfig', () => {
  it('returns configured:true with both values when both are set', () => {
    expect(
      readEmbeddedSignupConfig({
        META_APP_ID: 'app-123',
        WHATSAPP_ES_CONFIG_ID: 'config-456',
      } as NodeJS.ProcessEnv),
    ).toEqual({ appId: 'app-123', configId: 'config-456', configured: true });
  });

  it('returns configured:false with configId null when only appId is set', () => {
    expect(
      readEmbeddedSignupConfig({
        META_APP_ID: 'app-123',
      } as NodeJS.ProcessEnv),
    ).toEqual({ appId: 'app-123', configId: null, configured: false });
  });

  it('returns configured:false with appId null when only configId is set', () => {
    expect(
      readEmbeddedSignupConfig({
        WHATSAPP_ES_CONFIG_ID: 'config-456',
      } as NodeJS.ProcessEnv),
    ).toEqual({ appId: null, configId: 'config-456', configured: false });
  });

  it('returns both null and configured:false when neither is set', () => {
    expect(readEmbeddedSignupConfig({} as NodeJS.ProcessEnv)).toEqual({
      appId: null,
      configId: null,
      configured: false,
    });
  });

  it('treats an empty string as unset', () => {
    expect(
      readEmbeddedSignupConfig({
        META_APP_ID: '',
        WHATSAPP_ES_CONFIG_ID: '',
      } as NodeJS.ProcessEnv),
    ).toEqual({ appId: null, configId: null, configured: false });
  });
});
