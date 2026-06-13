export class TikTokComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TikTokComplianceError';
  }
}

export interface TikTokComplianceInput {
  privacyLevel?: string;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  discloseContent?: boolean;
}

/**
 * Enforces TikTok's Required UX rules at the API boundary.
 * Mirrors Point 3 of TikTok's Content Sharing Guidelines.
 */
export function assertTikTokCompliance(input: TikTokComplianceInput): void {
  const { privacyLevel, brandContentToggle, brandOrganicToggle, discloseContent } = input;

  if (discloseContent && !brandContentToggle && !brandOrganicToggle) {
    throw new TikTokComplianceError(
      'Commercial content disclosure is enabled but neither "Your Brand" nor "Branded Content" was selected.',
    );
  }

  if (brandContentToggle && privacyLevel === 'SELF_ONLY') {
    throw new TikTokComplianceError(
      'Branded content cannot be posted with private visibility. Choose Public or Friends.',
    );
  }
}
