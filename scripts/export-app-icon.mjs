/**
 * 从 resources/icon.svg 生成桌面图标、renderer favicon 和 Chrome extension 图标。
 * 需要: npm i -D sharp
 * 运行: node scripts/export-app-icon.mjs
 */
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(root, 'resources', 'icon.svg')
const outDir = join(root, 'build')
const outPng = join(outDir, 'icon.png')
const outIco = join(outDir, 'icon.ico')
const outFavicon = join(root, 'src', 'renderer', 'public', 'icon.svg')
const extensionDir = join(root, 'resources', 'chrome-extension')
const extensionIconSizes = [16, 32, 48, 128]

function pngToIco(pngBuffer) {
  // 生成只含一张 256x256 PNG 的 .ico（Windows 任务栏/托盘可直接解析）
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // Reserved
  header.writeUInt16LE(1, 2) // Type: icon
  header.writeUInt16LE(1, 4) // Count

  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0) // Width: 0 表示 256
  entry.writeUInt8(0, 1) // Height: 0 表示 256
  entry.writeUInt8(0, 2) // Colors
  entry.writeUInt8(0, 3) // Reserved
  entry.writeUInt16LE(1, 4) // Planes
  entry.writeUInt16LE(32, 6) // Bit count
  entry.writeUInt32LE(pngBuffer.length, 8) // Bytes in res
  entry.writeUInt32LE(22, 12) // Offset

  return Buffer.concat([header, entry, pngBuffer])
}

async function main() {
  let sharp
  try {
    sharp = (await import('sharp')).default
  } catch {
    console.error('请先安装: npm i -D sharp')
    process.exit(1)
  }
  const svg = await readFile(svgPath)
  await mkdir(outDir, { recursive: true })
  await mkdir(extensionDir, { recursive: true })

  await writeFile(outFavicon, svg)
  console.log('Wrote', outFavicon)
  for (const size of extensionIconSizes) {
    const output = join(extensionDir, `icon${size}.png`)
    await sharp(svg, { density: 300 }).resize(size, size).png().toFile(output)
    console.log('Wrote', output)
  }

  await sharp(svg, { density: 300 }).resize(1024, 1024).png().toFile(outPng)
  console.log('Wrote', outPng)

  const png256 = await sharp(svg, { density: 300 }).resize(256, 256).png().toBuffer()
  await writeFile(outIco, pngToIco(png256))
  console.log('Wrote', outIco)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
