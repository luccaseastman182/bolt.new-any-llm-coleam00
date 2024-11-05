import { useState } from 'react';
import { createScopedLogger } from '~/utils/logger';
import { createClient } from 'redis';
import fs from 'fs';
import path from 'path';

const logger = createScopedLogger('usePromptEnhancement');

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

export function usePromptEnhancer() {
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [promptEnhanced, setPromptEnhanced] = useState(false);

  const resetEnhancer = () => {
    setEnhancingPrompt(false);
    setPromptEnhanced(false);
  };

  const enhancePrompt = async (input: string, setInput: (value: string) => void) => {
    setEnhancingPrompt(true);
    setPromptEnhanced(false);

    const contextData = await getContextData('app/lib/hooks/usePromptEnhancer.ts');

    const response = await fetch('/api/enhancer', {
      method: 'POST',
      body: JSON.stringify({
        message: `${input}\n\nContext:\n${JSON.stringify(contextData, null, 2)}`,
      }),
    });

    const reader = response.body?.getReader();

    const originalInput = input;

    if (reader) {
      const decoder = new TextDecoder();

      let _input = '';
      let _error;

      try {
        setInput('');

        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          _input += decoder.decode(value);

          logger.trace('Set input', _input);

          setInput(_input);
        }
      } catch (error) {
        _error = error;
        setInput(originalInput);
      } finally {
        if (_error) {
          logger.error(_error);
        }

        setEnhancingPrompt(false);
        setPromptEnhanced(true);

        setTimeout(() => {
          setInput(_input);
        });
      }
    }
  };

  return { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer };
}
