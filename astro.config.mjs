import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// Detección automática del entorno de ejecución
const isProd = process.env.NODE_ENV === 'production';

export default defineConfig({
  // En producción usa tu dominio de GitHub Pages; en desarrollo local no es necesario
  site: isProd ? 'https://cienciadedatosysalud.github.io' : undefined,

  // En producción monta sobre la subcarpeta del repositorio (/misc/); en local corre en la raíz (/)
  base: isProd ? '/GeoSNS/' : '/',

  integrations: [react()],

  vite: {
    // Evita que Vite pre-empaquete DuckDB-WASM para no interferir con sus WebAssembly binarios
    optimizeDeps: {
      exclude: ['@duckdb/duckdb-wasm']
    }
  }
});