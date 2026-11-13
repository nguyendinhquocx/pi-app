import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

describe('Windows tray icon packaging contract', () => {
  it('generates the icon before every package path and ships the runtime ICO location', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const exporterPath = join(root, 'scripts', 'export-app-icon.mjs')
    const masterIcon = readFileSync(join(root, 'resources', 'icon.svg'))

    assert.ok(existsSync(join(root, 'resources', 'icon.svg')), 'icon source SVG must be committed')
    assert.deepEqual(
      readFileSync(join(root, 'src', 'renderer', 'public', 'icon.svg')),
      masterIcon,
      'renderer favicon must be generated from the same master SVG',
    )
    const extensionManifest = JSON.parse(readFileSync(join(root, 'resources', 'chrome-extension', 'manifest.json'), 'utf8'))
    for (const size of [16, 32, 48, 128]) {
      assert.equal(extensionManifest.icons[String(size)], `icon${size}.png`)
      assert.ok(existsSync(join(root, 'resources', 'chrome-extension', `icon${size}.png`)))
    }
    assert.ok(existsSync(exporterPath), 'icon exporter script must be committed')

    const exporter = readFileSync(exporterPath, 'utf8')
    assert.match(
      exporter,
      /const\s+outIco\s*=\s*join\(outDir,\s*['"]icon\.ico['"]\)/,
      'exporter must target build/icon.ico',
    )
    assert.match(
      exporter,
      /writeFile\(outIco,\s*pngToIco\(png256\)\)/,
      'exporter must write the generated ICO bytes',
    )
    assert.match(exporter, /src',\s*'renderer',\s*'public',\s*'icon\.svg'/)
    assert.match(exporter, /extensionIconSizes\s*=\s*\[16,\s*32,\s*48,\s*128\]/)
    assert.match(
      pkg.scripts['icon:export'],
      /node scripts\/export-app-icon\.mjs/,
      'icon:export must run the exporter',
    )
    assert.match(pkg.scripts.package, /icon:export\s*&&/, 'generic package must generate app icons first')
    assert.match(pkg.scripts['package:win'], /icon:export\s*&&/, 'Windows package must generate app icons first')
    assert.match(builder, /from:\s*build\/icon\.ico[\s\S]*to:\s*resources\/build\/icon\.ico/)
  })
})
