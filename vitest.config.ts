import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			obsidian: resolve(__dirname, 'tests/mocks/obsidian.ts'),
		},
	},
	test: {
		environment: 'node',
		include: ['tests/sync/**/*.test.ts'],
		threads: false,
		clearMocks: true,
		restoreMocks: true,
	},
});

