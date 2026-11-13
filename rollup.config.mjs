import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

/** @type {import('rollup').RollupOptions} */
export default {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
    inlineDynamicImports: true
  },
  onwarn(warning, warn) {
    // Third-party noise from bundled @actions/* packages
    if (warning.id?.includes('node_modules')) return
    if (warning.code === 'CIRCULAR_DEPENDENCY') return
    warn(warning)
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json' }),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    json()
  ]
}
