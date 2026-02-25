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
                dashboard: resolve(__dirname, 'dashboard.html'),
                dailyOps: resolve(__dirname, 'daily-ops.html'),
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
