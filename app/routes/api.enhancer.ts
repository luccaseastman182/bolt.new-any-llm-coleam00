import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { StreamingTextResponse, parseStreamPart } from 'ai';
import { streamText } from '~/lib/.server/llm/stream-text';
import { stripIndents } from '~/utils/stripIndent';
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

export async function action(args: ActionFunctionArgs) {
  return enhancerAction(args);
}

async function enhancerAction({ context, request }: ActionFunctionArgs) {
  const { message } = await request.json<{ message: string }>();

  const contextData = await getContextData('app/routes/api.enhancer.ts');

  try {
    const result = await streamText(
      [
        {
          role: 'user',
          content: stripIndents`
          I want you to improve the user prompt that is wrapped in \`<original_prompt>\` tags.

          IMPORTANT: Only respond with the improved prompt and nothing else!

          <original_prompt>
            ${message}
          </original_prompt>

          Context:
          ${JSON.stringify(contextData, null, 2)}
        `,
        },
      ],
      context.cloudflare.env,
    );

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const processedChunk = decoder
          .decode(chunk)
          .split('\n')
          .filter((line) => line !== '')
          .map(parseStreamPart)
          .map((part) => part.value)
          .join('');

        controller.enqueue(encoder.encode(processedChunk));
      },
    });

    const transformedStream = result.toAIStream().pipeThrough(transformStream);

    return new StreamingTextResponse(transformedStream);
  } catch (error) {
    console.log(error);

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
