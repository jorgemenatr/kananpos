import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Versión de esta compilación: el commit en Netlify (COMMIT_REF) o la hora de
 * compilación. La app la lleva adentro y también se publica en /version.json:
 * una pestaña abierta compara las dos para saber si ya hay una versión nueva.
 */
// Sin @types/node en el proyecto: process se toma de globalThis.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const APP_VERSION = env.COMMIT_REF || `local-${Date.now()}`

function versionFile(): Plugin {
  return {
    name: 'kanan-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: APP_VERSION }) })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), versionFile()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  // App interna de laptop: un bundle de ~600 kB es aceptable.
  build: { chunkSizeWarningLimit: 800 },
})
