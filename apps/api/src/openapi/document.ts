import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';

export interface DocumentOptions {
  title?: string;
  version?: string;
  description?: string;
  serverUrl?: string;
}

export function generateOpenAPIDocument(
  options: DocumentOptions = {}
): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: options.title ?? 'Wolff API',
      version: options.version ?? '0.1.0',
      description:
        options.description ??
        'Quote-to-cash API for agencies and freelancers. All public routes require a workspace API key.',
    },
    servers: [{ url: options.serverUrl ?? 'http://localhost:4000' }],
  });
}
