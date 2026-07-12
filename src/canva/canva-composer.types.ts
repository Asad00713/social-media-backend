export interface ComposerCanvaStatus {
  connected: boolean;
  displayName?: string;
}

export interface ComposerCanvaDesignItem {
  id: string;
  title: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  updatedAt?: string;
}

export interface ComposerCanvaDesignsResult {
  items: ComposerCanvaDesignItem[];
  continuation?: string;
}

export interface ComposerCanvaImportResult {
  url: string;
  type: 'image';
  width?: number;
  height?: number;
  sizeBytes: number;
}
