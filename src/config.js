import slugify from '@sindresorhus/slugify'
import glob from 'fast-glob'
import kleur from 'kleur'
import path, { isAbsolute, join, relative } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from './fs.js'
import { getWorkspaceRoot } from './getWorkspaceRoot.js'
import { isTest } from './isTest.js'
import { logger } from './logger/logger.js'
import { getPackageManager, getRepoDetails } from './workspace.js'

/**
 * @typedef {import('../index.js').LazyConfig} LazyConfig
 */

/**
 * @typedef {{config: LazyConfig, filePath: null | string}} LoadedConfig
 */

/**
 * @returns {Promise<LoadedConfig>}
 * @param {string} dir
 */
export async function getConfigFromDir(dir) {
  const files = glob.sync('lazy.config.{js,cjs,mjs,ts,cts,mts,json}', {
    absolute: true,
    cwd: dir,
  })

  if (files.length > 1) {
    logger.fail(`Found multiple lazy config files in dir '${dir}'.`, {
      detail: `Remove all but one of the following files: ${files.join(', ')}`,
    })
    process.exit(1)
  }

  if (files.length === 0) {
    return { filePath: null, config: {} }
  } else {
    const file = files[0]
    const config = await loadConfigObject(dir, file)

    if (!config) {
      throw new Error(`Invalid config file`)
    }

    // TODO: Proper validation
    return { filePath: file, config }
  }
}

/**
 * @param {string} dir
 * @param {string} file
 * @returns {Promise<LazyConfig>}
 */
async function loadConfigObject(dir, file) {
  if (file.endsWith('.json')) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  if (file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs')) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return (await import(file)).default
  }

  const configDir = join(dir, '.lazy')
  if (!existsSync(configDir)) {
    mkdirSync(configDir)
  }

  const inFile = join(configDir, 'config.source.mjs')
  writeFileSync(inFile, `import config from '${file}'; export default config`)
  const outFile = join(configDir, 'config.cache.mjs')

  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [inFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    packages: 'external',
    sourcemap: 'inline',
    sourcesContent: true,
    format: 'esm',
  })

  if (!isTest) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    await import('source-map-support/register.js')
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
  return (await import(outFile)).default
}

export class TaskConfig {
  /**
   * @param {string} dir
   * @param {string} name
   * @param {import("./types.js").LazyTask} config
   */
  constructor(dir, name, config) {
    this.dir = dir
    this.name = name
    this._config = config
  }

  getManifestPath() {
    const dir = path.join(this.dir, '.lazy', 'manifests')
    return path.join(dir, slugify(this.name))
  }

  getNextManifestPath() {
    const dir = path.join(this.dir, '.lazy', 'manifests')
    return path.join(dir, slugify(this.name) + '.next')
  }

  getDiffPath() {
    const dir = path.join(this.dir, '.lazy', 'diffs')
    return path.join(dir, slugify(this.name))
  }

  get runType() {
    return this._config.runType ?? 'dependent'
  }

  get baseCommand() {
    return this._config.baseCommand
  }

  get runsAfter() {
    return this._config.runsAfter ?? {}
  }

  get parallel() {
    return this._config.parallel ?? true
  }

  get cache() {
    const cache = this._config.cache
    if (cache === 'none') {
      return cache
    } else {
      return {
        envInputs: cache?.envInputs ?? [],
        inheritsInputFromDependencies: cache?.inheritsInputFromDependencies ?? true,
        inputs: extractGlobPattern(cache?.inputs),
        outputs: extractGlobPattern(cache?.outputs),
        usesOutputFromDependencies: cache?.usesOutputFromDependencies ?? true,
      }
    }
  }
}

/**
 *
 * @param {import('./types.js').GlobConfig | null | undefined} glob
 * @returns {{include: string[], exclude: string[]}}
 */
function extractGlobPattern(glob) {
  if (!glob) {
    return {
      include: ['**/*'],
      exclude: [],
    }
  }
  if (Array.isArray(glob)) {
    return {
      include: glob,
      exclude: [],
    }
  }

  return { include: glob.include ?? ['**/*'], exclude: glob.exclude ?? [] }
}

export class Config {
  /** @private */ rootConfig
  /** @private */ packageDirConfigs
  /** @readonly */ workspaceRoot
  /** @readonly */ repoDetails

  /**
   * @typedef {Object} ConfigWrapperOptions
   *
   * @property {string} workspaceRoot
   * @property {LoadedConfig} rootConfig
   * @property {Record<string, LoadedConfig>} packageDirConfigs
   * @property {import('./types.js').RepoDetails} repoDetails
   */
  /** @param {ConfigWrapperOptions} options */
  constructor({ workspaceRoot, rootConfig, packageDirConfigs, repoDetails }) {
    this.workspaceRoot = workspaceRoot
    this.rootConfig = rootConfig
    this.packageDirConfigs = packageDirConfigs
    this.repoDetails = repoDetails
  }

  /**
   * @param {string} dir
   */
  static async from(dir) {
    const workspaceRoot = getWorkspaceRoot(dir)
    if (!workspaceRoot) {
      logger.fail(`Could not find workspace root for dir '${dir}'`)
      process.exit(1)
    }

    const packageManager = getPackageManager(workspaceRoot)
    if (!packageManager) {
      logger.fail(`Could not determine which package manager is in use '${dir}' '${workspaceRoot}'`)
    }

    const repoDetails = getRepoDetails(workspaceRoot)
    const rootConfig = await getConfigFromDir(workspaceRoot)

    /** @type {Record<string, LoadedConfig>} */
    const packageDirConfigs = {}
    const allLoadedConfigFiles = rootConfig.filePath ? [rootConfig.filePath] : []

    for (const c of await Promise.all(
      Object.values(repoDetails.packagesByName).map(async (pkg) => ({
        dir: pkg.dir,
        config: await getConfigFromDir(pkg.dir),
      })),
    )) {
      if (c.config.filePath !== null) {
        allLoadedConfigFiles.push(c.config.filePath)
        packageDirConfigs[c.dir] = c.config
      }
    }

    if (allLoadedConfigFiles.length === 0) {
      logger.log('No config files found, using default configuration.\n')
    } else {
      logger.log(
        kleur.gray(
          `Loaded config file${allLoadedConfigFiles.length > 1 ? 's' : ''}: ${allLoadedConfigFiles
            .map((f) => relative(process.cwd(), f))
            .join(', ')}\n`,
        ),
      )
    }

    return new Config({
      workspaceRoot,
      rootConfig,
      packageDirConfigs,
      repoDetails,
    })
  }
  /**
   * @param {string} taskDir
   * @param {string} taskName
   * @returns {TaskConfig}
   */
  getTaskConfig(taskDir, taskName) {
    const config = this.packageDirConfigs[taskDir]?.config ?? this.rootConfig.config
    return new TaskConfig(taskDir, taskName, config?.tasks?.[taskName] ?? {})
  }

  /**
   * @param {string} taskDir
   * @param {string} taskName
   */
  getTaskKey(taskDir, taskName) {
    if (!isAbsolute(taskDir)) throw new Error(`taskKey: taskDir must be absolute: ${taskDir}`)
    return `${taskName}::${relative(this.workspaceRoot, taskDir) || '<rootDir>'}`
  }

  /**
   * @param {string} taskDir
   * @returns {{includes: string[], excludes: string[], envInputs: string[]}}
   */
  getBaseCacheConfig(taskDir) {
    const config =
      this.packageDirConfigs[taskDir]?.config.baseCacheConfig ??
      this.rootConfig.config.baseCacheConfig

    const includes = config?.includes ?? [
      '<rootDir>/{yarn.lock,pnpm-lock.yaml,package-lock.json}',
      '<rootDir>/lazy.config.*',
    ]
    const excludes = config?.excludes ?? []
    return {
      includes,
      excludes,
      envInputs: config?.envInputs ?? [],
    }
  }
}
