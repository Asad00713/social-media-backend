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

/**
 * A design just created for this post.
 *
 * `editUrl` is the whole point: it is the Canva window the person
 * finishes the design in. Without it the design exists and is
 * unreachable, so the route fails rather than returning a row that
 * cannot be opened.
 */
export interface ComposerCanvaCreateResult {
  id: string;
  title: string;
  editUrl: string;
}
