import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const stripSlash = (url: string) => url.replace(/\/+$/, '');
const withSlash = (path: string) => (path.startsWith('/') ? path : `/${path}`);
const enc = encodeURIComponent;

/**
 * Every URL an email links to, built from env in one place. Bases are read
 * once and lose their trailing `/`; ids and tokens are URL-encoded.
 */
@Injectable()
export class AppLinks {
  private readonly frontendBase: string;
  private readonly apiBase: string;
  private readonly marketingBase: string;
  private readonly assetBaseUrl: string;
  private readonly support: string;

  constructor(config: ConfigService) {
    this.frontendBase = stripSlash(
      config.get<string>('FRONTEND_URL') || 'http://localhost:3001',
    );
    this.apiBase = stripSlash(
      config.get<string>('API_PUBLIC_URL') ||
        config.get<string>('APP_URL') ||
        'http://localhost:3000',
    );
    this.marketingBase = stripSlash(
      config.get<string>('MARKETING_URL') || 'https://schedura.ai',
    );
    this.assetBaseUrl = stripSlash(
      config.get<string>('EMAIL_ASSET_BASE_URL') ||
        `${this.frontendBase}/email`,
    );
    this.support = config.get<string>('SUPPORT_EMAIL') || 'support@schedura.ai';
  }

  frontend(path: string): string {
    return `${this.frontendBase}${withSlash(path)}`;
  }

  workspace(ws: string, path: string): string {
    return this.frontend(`/w/${enc(ws)}${withSlash(path)}`);
  }

  planner(ws: string, postId?: string): string {
    const query = postId ? `?post=${enc(postId)}` : '';
    return this.workspace(ws, `/planner${query}`);
  }

  channels(ws: string): string {
    return this.workspace(ws, '/channels');
  }

  billing(ws: string): string {
    return this.workspace(ws, '/settings/billing');
  }

  members(ws: string): string {
    return this.workspace(ws, '/settings/team');
  }

  notifications(ws: string): string {
    return this.workspace(ws, '/settings/notifications');
  }

  inbox(ws: string, conversationId: string): string {
    return this.workspace(ws, `/inbox?c=${enc(conversationId)}`);
  }

  invite(token: string): string {
    return this.frontend(`/invite/accept?token=${enc(token)}`);
  }

  resetPassword(token: string): string {
    return this.frontend(`/reset-password?token=${enc(token)}`);
  }

  api(path: string): string {
    return `${this.apiBase}${withSlash(path)}`;
  }

  assetBase(): string {
    return this.assetBaseUrl;
  }

  help(): string {
    return `${this.marketingBase}/help`;
  }

  billingHelp(): string {
    return `${this.marketingBase}/help/billing`;
  }

  privacy(): string {
    return `${this.marketingBase}/privacy`;
  }

  status(): string {
    return `${this.marketingBase}/status`;
  }

  supportEmail(): string {
    return this.support;
  }
}
