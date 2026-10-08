// @ts-check
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only this checkout's specs, not those of worktrees under .claude/worktrees
    include: ['src/**/*.spec.ts'],
  },
});
