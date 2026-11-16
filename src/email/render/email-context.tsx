import { createContext, useContext } from 'react';

export interface EmailContextValue {
  /** Where the logo, network glyphs and callout icons are served from. */
  assetBaseUrl: string;
}

export const EmailContext = createContext<EmailContextValue>({
  assetBaseUrl: '',
});

/** Absolute URL of a shipped email asset, e.g. `logo.png`. */
export function useAssetUrl(name: string): string {
  const { assetBaseUrl } = useContext(EmailContext);
  return `${assetBaseUrl.replace(/\/+$/, '')}/${name}`;
}
