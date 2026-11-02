/**
 * NO `.env.example` ADVERTISES A MODEL FOR A CLASSIFICATION. The platform allows,
 * the classification selects, the profile uses.
 *
 * The model a classification's assistant answers on is that classification's own declared default
 * (`models.default`, carried in `GET /classifications`), so a frontend build variable that picked one per
 * classification would be a second, unregistered selection. Neither package reads one, and neither example
 * file offers one for a deployer to set.
 */
import * as fs from 'fs';
import * as path from 'path';

const PACKAGES = ['chat', 'admin'];
const pkgDir = (pkg: string) => path.resolve(__dirname, '..', '..', '..', 'frontend', 'packages', pkg);

describe('no frontend build variable selects a model', () => {
  for (const pkg of PACKAGES) {
    it(`${pkg}/.env.example offers no per-classification model key`, () => {
      const src = fs.readFileSync(path.join(pkgDir(pkg), '.env.example'), 'utf8');
      expect(src).not.toMatch(/VITE_\w*MODEL_KEY/);
      expect(src).not.toMatch(/# Supported keys:/);
    });
  }

  it('no frontend source reads one', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && /_MODEL_KEY\b/.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
      }
    };
    for (const pkg of [...PACKAGES, 'shared']) walk(path.join(pkgDir(pkg), 'src'));
    expect(hits).toEqual([]);
  });
});
