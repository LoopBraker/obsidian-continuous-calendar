import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/sync/**/*.test.ts'],
		threads: false,
		clearMocks: true,
		restoreMocks: true,
	},
});
