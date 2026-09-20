import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts','src/preload.ts','src/cli.ts','src/mcp.ts'], bundle: true, platform: 'node', target: 'node22', outdir: 'dist', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true });
await build({ entryPoints: ['src/renderer.ts'], bundle: true, platform: 'browser', target: 'chrome140', outfile: 'dist/renderer.js', sourcemap: true });
await Promise.all(['index.html', 'styles.css'].map(f => copyFile('src/'+f, 'dist/'+f)));
