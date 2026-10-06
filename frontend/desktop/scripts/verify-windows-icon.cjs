const fs = require('node:fs')
const path = require('node:path')

// Inspect the executable's PE resources rather than trusting the builder configuration.
// RT_GROUP_ICON entries reference the RT_ICON byte payloads copied from the source ICO.
function peIconResources(data) {
  const pe = data.readUInt32LE(0x3c)
  if (data.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a PE executable')
  const sectionCount = data.readUInt16LE(pe + 6)
  const optional = pe + 24
  const magic = data.readUInt16LE(optional)
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported PE optional header')
  const directory = optional + (magic === 0x20b ? 112 : 96)
  const resourceRva = data.readUInt32LE(directory + 16)
  if (!resourceRva) throw new Error('Executable has no resources')
  const sectionStart = optional + data.readUInt16LE(pe + 20)
  const sections = []
  for (let i = 0; i < sectionCount; i++) {
    const start = sectionStart + i * 40
    sections.push({
      rva: data.readUInt32LE(start + 12),
      size: Math.max(data.readUInt32LE(start + 8), data.readUInt32LE(start + 16)),
      file: data.readUInt32LE(start + 20),
    })
  }
  const offset = rva => {
    const section = sections.find(value => rva >= value.rva && rva < value.rva + value.size)
    if (!section) throw new Error('Resource RVA is outside the PE sections')
    return section.file + rva - section.rva
  }
  const root = offset(resourceRva)
  const resources = []
  function readDirectory(relative, ids) {
    if (ids.length > 3) throw new Error('Unexpected PE resource tree depth')
    const start = root + relative
    const count = data.readUInt16LE(start + 12) + data.readUInt16LE(start + 14)
    for (let i = 0; i < count; i++) {
      const entry = start + 16 + i * 8
      const name = data.readUInt32LE(entry)
      const id = name & 0x80000000 ? `name:${name & 0x7fffffff}` : name
      const target = data.readUInt32LE(entry + 4)
      const next = [...ids, id]
      if (target & 0x80000000) readDirectory(target & 0x7fffffff, next)
      else {
        const resource = root + target
        const address = offset(data.readUInt32LE(resource))
        const size = data.readUInt32LE(resource + 4)
        if (address + size > data.length) throw new Error('Truncated PE resource')
        resources.push({ type: next[0], id: next[1], language: next[2], data: data.subarray(address, address + size) })
      }
    }
  }
  readDirectory(0, [])
  return resources.filter(value => value.type === 3 || value.type === 14)
}

function verifyWindowsIcon(executable, sourceIco) {
  const ico = fs.readFileSync(sourceIco)
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Expected an ICO source file')
  const count = ico.readUInt16LE(4)
  if (!count) throw new Error('Source icon has no images')
  const resources = peIconResources(fs.readFileSync(executable))
  const groups = resources.filter(value => value.type === 14).sort((a, b) => Number(a.id) - Number(b.id))
  if (!groups.length) throw new Error('Packaged executable has no icon group')
  // Windows shell uses the first group by resource ID for the application/shortcut icon.
  for (const group of groups.filter(value => value.id === groups[0].id)) {
    if (group.data.readUInt16LE(4) !== count) throw new Error('Packaged icon size variants differ from the Amadeus icon')
    for (let i = 0; i < count; i++) {
      const source = 6 + i * 16
      const target = 6 + i * 14
      const size = ico.readUInt32LE(source + 8)
      const address = ico.readUInt32LE(source + 12)
      const iconId = group.data.readUInt16LE(target + 12)
      const icon = resources.find(value => value.type === 3 && value.id === iconId && value.language === group.language)
      // rcedit 1.x truncates the group byte-count for large PNG icons; inspect the
      // actual RT_ICON length/data instead, while comparing dimensions and format.
      if (!group.data.subarray(target, target + 8).equals(ico.subarray(source, source + 8)) ||
          !icon || !icon.data.equals(ico.subarray(address, address + size))) {
        throw new Error('Packaged executable still has a different icon; refusing to publish Electron branding')
      }
    }
  }
  return { images: count, group: groups[0].id }
}

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const source = path.resolve(__dirname, '../../../img/Amadeus/amadeus.ico')
  const result = verifyWindowsIcon(executable, source)
  console.log(`  • verified Amadeus executable icon (${result.images} size variants)`)
}
module.exports.verifyWindowsIcon = verifyWindowsIcon

if (require.main === module) {
  const executable = process.argv[2]
  if (!executable) throw new Error('Usage: node scripts/verify-windows-icon.cjs <executable> [source.ico]')
  const result = verifyWindowsIcon(path.resolve(executable), process.argv[3] || path.resolve(__dirname, '../../../img/Amadeus/amadeus.ico'))
  console.log(JSON.stringify(result))
}
