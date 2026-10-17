// Per-process scratch DSH_HOME for the tests. Keeping `DSH_HOME` inside the OS
// temp directory means nothing a test does can touch a real profile, the real
// `%DSH_HOME%`, or the plugin state a user is actually running.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dir = null

/**
 * Point this process at a throwaway DSH_HOME and return its path.
 * @param {string} label - short name that identifies the test in the temp path.
 * @returns {string} the absolute temp home.
 */
export function useTempHome(label) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `phone-bridge-${label}-`))
  process.env.DSH_HOME = dir
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the OS reaps temp files anyway */
    }
  }
  process.on('exit', cleanup)
  return dir
}

/** Path of the throwaway home created by {@link useTempHome}. */
export function tempHome() {
  return dir
}
