/**
 * LLM Provider Abstraction Layer
 *
 * Defines the contract for all LLM providers (Groq, OpenAI, Anthropic, Google, etc.)
 * Each provider implements this interface to enable seamless model switching.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LLMToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>; // JSON Schema
  };
}

export interface LLMChatOptions {
  model?: string;
  tools?: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Discriminated union for stream chunks
export type LLMStreamChunk =
  | { type: 'content'; content: string }
  | { type: 'tool_calls'; toolCalls: LLMToolCall[] }
  | { type: 'done'; usage?: LLMUsage };

// Non-streaming response
export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  model: string;
  usage?: LLMUsage;
}

/**
 * Abstract base class for LLM providers.
 * Implement this to add a new LLM provider (OpenAI, Anthropic, etc.)
 */
export abstract class BaseLLMProvider {
  abstract readonly name: string;
  abstract readonly models: string[];

  /** Non-streaming chat completion */
  abstract chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse>;

  /** Streaming chat completion */
  abstract chatStream(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): AsyncGenerator<LLMStreamChunk>;
}
