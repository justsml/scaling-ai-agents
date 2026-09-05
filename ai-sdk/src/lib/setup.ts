import { cp, mkdir, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = resolve(root, '..', 'shared', 'fixtures')
const destination = resolve(root, 'src', 'fixtures')

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
console.log(`copied ${(await readdir(destination)).length} fixture entries into src/fixtures`)
