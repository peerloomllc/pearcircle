#!/usr/bin/env node
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

const root = path.resolve(__dirname)
const outDir = path.join(root, 'dist')
fs.mkdirSync(outDir, { recursive: true })

const watch = process.argv.includes('--watch')

const buildOpts = {
  entryPoints: [path.join(root, 'src', 'main.jsx')],
  bundle: true,
  format: 'iife',
  outfile: path.join(outDir, 'app.js'),
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.jsx': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
  minify: !watch,
}

const cssOpts = {
  entryPoints: [path.join(root, 'src', 'style.css')],
  bundle: true,
  outfile: path.join(outDir, 'style.css'),
  loader: { '.css': 'css' },
  minify: !watch,
  logLevel: 'info',
}

async function run () {
  if (watch) {
    const c1 = await esbuild.context(buildOpts)
    const c2 = await esbuild.context(cssOpts)
    await Promise.all([c1.watch(), c2.watch()])
    process.stdout.write('watching…\n')
  } else {
    await Promise.all([esbuild.build(buildOpts), esbuild.build(cssOpts)])
  }
}

run().catch((e) => { console.error(e); process.exit(1) })
