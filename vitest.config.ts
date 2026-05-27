import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Assembler tests run on Node; the assembler is a pure transform
    // function, so we don't need miniflare/workers-runtime here.
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/assembler/**/*.ts'],
      exclude: [
        'src/lib/assembler/fixtures/**',
        'src/lib/assembler/__tests__/**',
      ],
    },
  },
});
