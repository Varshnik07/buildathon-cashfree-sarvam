import { build } from 'esbuild';
await build({ entryPoints: ['client/browser-voice.js'], bundle: true, format: 'esm', platform: 'browser', outfile: 'public/browser-voice.js', minify: true, drop: ['console'] });
