import { mkdir, readdir, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const lib = join(root, 'lib')

await mkdir(lib, { recursive: true })

const built = []
for (const name of await readdir(src)) {
  if (!name.endsWith('.js')) continue
  await copyFile(join(src, name), join(lib, name))
  built.push(name)
}

if (built.length === 0) {
  console.error('[dsh-plugin-undo] no .js files found in src/')
  process.exit(1)
}

console.log(`[dsh-plugin-undo] built lib/: ${built.join(', ')}`)
