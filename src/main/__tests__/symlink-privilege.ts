import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Probe whether the current OS user can create symlinks at all.
 * POSIX always can; Windows needs Developer Mode (or an admin token) and
 * otherwise throws EPERM, so real-filesystem symlink tests must skip instead
 * of failing. A dangling target works on POSIX and still fails with EPERM on
 * unprivileged Windows, so the probe does not need a real target file.
 */
export const canCreateSymlinks: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'symlink-probe-'))
  try {
    symlinkSync(join(dir, 'missing-target'), join(dir, 'probe-link'))
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'EPERM' || code === 'EACCES') {
      console.warn('[symlink tests] skipped: no symlink privilege (enable Windows Developer Mode or run on POSIX)')
      return false
    }
    throw error
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
