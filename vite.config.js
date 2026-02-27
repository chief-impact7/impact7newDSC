import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
    root: './',
    plugins: [react()],
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                excel: resolve(__dirname, 'excel.html'),
                dashboard: resolve(__dirname, 'dashboard.html'),
            },
        },
    },
    server: {
        watch: {
            usePolling: true,
        },
        host: true,
        port: 5174
    }
})
