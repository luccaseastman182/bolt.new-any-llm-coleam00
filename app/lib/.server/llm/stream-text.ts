import { streamText as _streamText, convertToCoreMessages } from 'ai';
import { getModel } from '~/lib/.server/llm/model';
import { MAX_TOKENS } from './constants';
import { getSystemPrompt } from './prompts';
import { MODEL_LIST, DEFAULT_MODEL, DEFAULT_PROVIDER } from '~/utils/constants';
import { createClient } from 'redis';
import fs from 'fs';
import path from 'path';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

await redisClient.connect();

const contextCache = new Map();

async function getContextData(filePath) {
  if (contextCache.has(filePath)) {
    return contextCache.get(filePath);
  }

  const cachedContext = await redisClient.get(filePath);
  if (cachedContext) {
    contextCache.set(filePath, JSON.parse(cachedContext));
    return JSON.parse(cachedContext);
  }

  const contextFilePath = path.join(process.cwd(), 'context.json');
  const contextData = JSON.parse(fs.readFileSync(contextFilePath, 'utf8'));

  const fileContext = contextData[filePath] || null;
  if (fileContext) {
    await redisClient.set(filePath, JSON.stringify(fileContext), {
      EX: 3600,
    });
    contextCache.set(filePath, fileContext);
  }

  return fileContext;
}

interface ToolResult<Name extends string, Args, Result> {
  toolCallId: string;
  toolName: Name;
  args: Args;
  result: Result;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolInvocations?: ToolResult<string, unknown, unknown>[];
  model?: string;
}

export type Messages = Message[];

export type StreamingOptions = Omit<Parameters<typeof _streamText>[0], 'model'>;

function extractModelFromMessage(message: Message): { model: string; content: string } {
  const modelRegex = /^\[Model: (.*?)\]\n\n/;
  const match = message.content.match(modelRegex);

  if (match) {
    const model = match[1];
    const content = message.content.replace(modelRegex, '');
    return { model, content };
  }

  // Default model if not specified
  return { model: DEFAULT_MODEL, content: message.content };
}

export async function streamText(messages: Messages, env: Env, options?: StreamingOptions) {
  let currentModel = DEFAULT_MODEL;
  const processedMessages = await Promise.all(messages.map(async (message) => {
    if (message.role === 'user') {
      const { model, content } = extractModelFromMessage(message);
      if (model && MODEL_LIST.find((m) => m.name === model)) {
        currentModel = model; // Update the current model
      }
      const contextData = await getContextData('app/lib/.server/llm/stream-text.ts');
      return { ...message, content: `${content}\n\nContext:\n${JSON.stringify(contextData, null, 2)}` };
    }
    return message;
  }));

  const provider = MODEL_LIST.find((model) => model.name === currentModel)?.provider || DEFAULT_PROVIDER;

  return _streamText({
    model: getModel(provider, currentModel, env),
    system: getSystemPrompt(),
    maxTokens: MAX_TOKENS,
    messages: convertToCoreMessages(processedMessages),
    ...options,
  });
}
