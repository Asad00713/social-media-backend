import { LLMToolDefinition } from '../llm/llm-provider.interface';

/**
 * Context passed to every tool execution.
 * Contains the current user and workspace information.
 */
export interface ToolContext {
  userId: string;
  workspaceId: string;
}

/**
 * Result returned by a tool execution.
 */
export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Interface for defining a chatbot tool.
 * Each tool represents an action the AI assistant can perform.
 */
export interface ChatbotTool {
  /** Unique tool name (e.g., 'get_user_profile') */
  name: string;

  /** Human-readable description for the LLM */
  description: string;

  /** JSON Schema for the tool's parameters */
  parameters: Record<string, any>;

  /** Whether this tool requires user confirmation before executing (e.g., delete operations) */
  requiresConfirmation?: boolean;

  /** Generate a human-readable confirmation message for the user */
  confirmationMessage?: (params: Record<string, any>) => string;

  /** Execute the tool with given parameters and context */
  execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult>;
}

/**
 * Converts a ChatbotTool to the LLM tool definition format.
 * Non-required parameters are made nullable so the LLM API doesn't
 * reject tool calls where the LLM passes null for optional params.
 */
export function toToolDefinition(tool: ChatbotTool): LLMToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: makeNonRequiredNullable(tool.parameters),
    },
  };
}

/**
 * Walk a JSON Schema and make every non-required property accept null.
 * Converts `{ type: 'string' }` → `{ type: ['string', 'null'] }` for
 * properties not listed in `required`.
 */
function makeNonRequiredNullable(
  schema: Record<string, any>,
): Record<string, any> {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return schema;
  }

  const required = new Set<string>(schema.required || []);
  const newProperties: Record<string, any> = {};

  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    if (required.has(key)) {
      newProperties[key] = prop;
    } else {
      // Make optional property accept null
      const currentType = prop.type;
      if (typeof currentType === 'string') {
        newProperties[key] = { ...prop, type: [currentType, 'null'] };
      } else if (Array.isArray(currentType) && !currentType.includes('null')) {
        newProperties[key] = { ...prop, type: [...currentType, 'null'] };
      } else {
        newProperties[key] = prop;
      }
    }
  }

  return { ...schema, properties: newProperties };
}
