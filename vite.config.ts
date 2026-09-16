import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs, so the build also works under https://USER.github.io/REPO/.
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
