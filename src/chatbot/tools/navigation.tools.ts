import { ChatbotTool, ToolResult } from './tool.interface';

const VALID_ROUTES = new Set([
  '/dashboard',
  '/posts',
  '/posts/create',
  '/calendar',
  '/channels',
  '/channels/connect',
  '/drip-campaigns',
  '/media-library',
  '/community',
  '/analytics',
  '/ai',
  '/settings',
  '/settings/members',
  '/billing',
  '/notifications',
  '/profile',
]);

const VALID_THEMES = new Set([
  'light',
  'dark',
  'blue',
  'green',
  'purple',
  'red',
  'orange',
  'pink',
  'indigo',
  'teal',
  'cyan',
  'system',
]);

export function createNavigationTools(): ChatbotTool[] {
  return [
    {
      name: 'navigate_to_page',
      description:
        'Navigate the user to a specific page in the app. Use this when the user asks to go to a page, wants to create a post (navigate to /posts/create), view their calendar, manage channels, etc. Returns a navigation action that the frontend will execute.',
      parameters: {
        type: 'object',
        properties: {
          route: {
            type: 'string',
            description:
              'The route to navigate to. Valid routes: /dashboard, /posts, /posts/create, /calendar, /channels, /channels/connect, /drip-campaigns, /media-library, /community, /analytics, /ai, /settings, /settings/members, /billing, /notifications, /profile',
          },
        },
        required: ['route'],
      },
      execute: async (params: Record<string, any>): Promise<ToolResult> => {
        const route = params.route as string;

        if (!VALID_ROUTES.has(route)) {
          return {
            success: false,
            error: `Invalid route "${route}". Valid routes are: ${Array.from(VALID_ROUTES).join(', ')}`,
          };
        }

        return {
          success: true,
          data: {
            action: 'navigate',
            route,
          },
        };
      },
    },
    {
      name: 'change_theme',
      description:
        'Change the app UI theme or color scheme. Use this when the user asks to change the color, theme, switch to dark/light mode, or set a specific accent color. The frontend will apply the change immediately. IMPORTANT: Only call this tool alone — do NOT also call navigate_to_page when changing the theme.',
      parameters: {
        type: 'object',
        properties: {
          theme: {
            type: 'string',
            description:
              'The theme to apply. Allowed values: "dark", "light", "system" for mode, or a color name: "blue", "green", "purple", "red", "orange", "pink", "indigo", "teal", "cyan" for the accent color.',
          },
        },
        required: ['theme'],
      },
      execute: async (params: Record<string, any>): Promise<ToolResult> => {
        const theme = (params.theme as string).toLowerCase();

        if (!VALID_THEMES.has(theme)) {
          return {
            success: false,
            error: `Invalid theme "${theme}". Available themes: ${Array.from(VALID_THEMES).join(', ')}`,
          };
        }

        return {
          success: true,
          data: {
            action: 'change_theme',
            theme,
          },
        };
      },
    },
  ];
}
