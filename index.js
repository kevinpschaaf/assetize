'use strict'
const system = require('@perl/system')
const qx = require('@perl/qx')
const path = require('path')
const Bluebird = require('bluebird')
const fs = require('fs')
const unlink = Bluebird.promisify(fs.unlink)
const readFile = Bluebird.promisify(fs.readFile)
const writeFile = Bluebird.promisify(fs.writeFile)
const rename = Bluebird.promisify(fs.rename)
const stat = Bluebird.promisify(fs.stat)
const chmod = Bluebird.promisify(fs.chmod)
const mkdirp = Bluebird.promisify(require('mkdirp'))
const rimraf = Bluebird.promisify(require('rimraf'))
const glob = Bluebird.promisify(require('glob'))
const yargs = require('@iarna/cli')(main)
  .usage('assetize [<modules…>]')
  .help()

async function main (opts, name) {
  try {
    const proj = JSON.parse(await readFile('package.json'))
    const assetDeps = proj.assetDependencies || {}
    await installModules(proj, Object.keys(assetDeps).map(n => `${n}@${assetDeps[n]}`), true)
    await Bluebird.map(seenThisRun, name => transformTheJS(name))
  } catch (_) {
    yargs.showHelp()
  }
}

const seenThisRun = new Set()

async function installModules (proj, modules) {
  await Bluebird.map(modules, name => installModule(proj, name))
}

async function installModule (proj, name) {
  let packument = JSON.parse(await qx`npm show ${name} --json`)
  if (Array.isArray(packument)) packument = packument[0]
  if (seenThisRun.has(packument.name)) return
  console.log('! installing', name)
  seenThisRun.add(packument.name)
  const tarball = await qx`npm pack "${name}"`
  const pkg = await Bluebird.resolve(installFromTarball(proj, packument, tarball)).finally(() => unlink(tarball))
}

function hasScope (name) {
  return String(name)[0] === '@'
}

async function installFromTarball (proj, packument, tarball) {
  await rimraf(`assets/${packument.name}`)
  await mkdirp(`assets/${packument.name}`)
  await system(`tar xf "${tarball}" --strip-components 1 -C "assets/${packument.name}"`)
  const pkg = JSON.parse(await readFile(`assets/${packument.name}/package.json`))
  await installModules(proj, Object.keys(pkg.dependencies || {}).map(name => `${name}@${pkg.dependencies[name]}`))
  let main = (pkg.main || 'index.js').replace(/[.]mjs$/, '.js')
  if (!await exists(main) && await exists(main + '.js')) {
    main += '.js'
  }
  const prefix = hasScope(pkg.name) ? pkg.name.slice(pkg.name.indexOf('/')+1) : pkg.name

  await writeFile(`assets/${pkg.name}.js`,
    `export * from './${prefix}/${main}'\n` +
    `import def from './${prefix}/${main}'\n` +
    `export default def\n`)
  return pkg
}

function parseReq (name) {
  const matched = name.match(/^([.]|(?:[@][^/]+[/])?[^@/]+)(?:[/]([^@]+))?$/)
  return {
    name: matched[1],
    pathinfo: matched[2]
  }
}

async function exists (name) {
  try {
    await stat(name)
    return true
  } catch (_) {
    return false
  }
}

async function resolvePath(dir, modpath) {
  if (await exists(path.join(dir, modpath))) {
    // Path exists, check if it was a file or directory
    const stats = await stat(path.join(dir, modpath));
    if (stats.isDirectory()) {
      let entry;
      // If there's a package.json in the directory, use its module/main
      if (exists(path.join(dir, modpath, 'package.json'))) {
        try {
          const pkg = JSON.parse(await readFile(path.join(dir, modpath, 'package.json')));
          entry = pkg.module || pkg['jsnext:main'] || pkg.main;
        } catch (e) {}
      }
      // Fallback to index.js
      entry = path.join(modpath, entry || 'index.js');
      if (exists(path.join(dir, entry))) {
        return entry;
      } else {
        console.warn(`WARNING: Could not resolve path '${modpath}'; could not find file in this directory`);
      }
    } else if (stats.isFile()) {
      // Use the original path if it's already a file
      return modpath;
    } else {
      console.warn(`WARNING: Could not resolve path '${modpath}'; something weird there`);
    }
  } else if (await exists(path.join(dir, modpath + '.js'))) {
    // Try the path with a .js extension
    return modpath + '.js';
  } else {
    console.warn(`WARNING: Could not resolve path '${modpath}'; could not find file at this path`);
  }
}

async function transformTheJS (name) {
  const mjs = await glob(`assets/${name}/**/*.mjs`)
  await Bluebird.map(mjs, file => rename(file, file.replace(/[.]mjs$/, '.js')))
  const js = await glob(`assets/${name}/**/*.js`)
  await Bluebird.map(js, async file => {
    let content = await readFile(file, 'utf8')
    // Find all the imports
    let match
    const matches = []
    const re = /(import.*from.*['"])([A-Za-z@.][-A-Za-z0-9_/]+[^"']*)/g
    while ((match = re.exec(content)) !== null) {
      matches.push(match);
    }
    // Resolve the import's name to a path
    const fixes = await Bluebird.map(matches, async ([match, prelude, spec]) => {
      const thisModule = parseReq(spec)
      path.relative('assets/foo/bar.js', path.resolve('assets/foo/bar.js', './././foo.js'))
      let modpath = thisModule.name[0] === '.'
                  ? path.relative(path.dirname(file), path.resolve(path.dirname(file), thisModule.name))
                  : path.relative(path.dirname(file), path.resolve(`assets/${thisModule.name}`))
      if (thisModule.pathinfo) {
        modpath += (modpath ? '/' : './') + thisModule.pathinfo.trim()
      }
      modpath = modpath.replace(/([.]mjs)$/, '.js')
      if (modpath = await resolvePath(path.dirname(file), modpath)) {
        const fixed = prelude + modpath;
        if (fixed !== match) {
          console.log(`${file}\n  ${match}\n  ${fixed}`);
          return {match, fixed};
        }
      }
    })
    // Replace all the fixed imports (dollars must be escaped)
    content = fixes.reduce((content, fix) => 
      fix ? content.replace(fix.match, fix.fixed.replace('$', '$$$$')) : content, content)
    // A little help for not-quite-web-compatible module source
    content = content.replace('process.env', 'self.process.env');
    await writeFile(file, content)
    // Some tarballs have non +rx source, thus not servable via apache
    await chmod(file, '755')
  })
}
