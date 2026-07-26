import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds `.openapi()` to Zod schemas. Every contract imports `z` from here so
// the extension is applied exactly once, before any schema is built.
extendZodWithOpenApi(z);

export { z };
