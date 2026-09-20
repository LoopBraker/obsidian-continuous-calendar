import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('sync fixtures', () => {
	it('contain no token-shaped fixture values', () => {
		const directory = join(__dirname, 'fixtures');
		const prohibited = [
			/ya29\./i,
			/1\/\/[^\s"']+/,
			/bearer\s+[a-z0-9._~-]{12,}/i,
			/(?:refresh|access)[_-]?token\s*[=:]\s*[^\s"']+/i,
		];
		for (const filename of readdirSync(directory)) {
			const content = readFileSync(join(directory, filename), 'utf8');
			for (const pattern of prohibited) expect(content).not.toMatch(pattern);
		}
	});
});

